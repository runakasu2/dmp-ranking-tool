import {test} from 'node:test';
import assert from 'node:assert/strict';
import {PGlite} from '@electric-sql/pglite';
import {candidates,queueMigration,restriction,usage} from '../src/acquisition.js';
import {migrate} from '../src/db.js';
import {claim,enqueue,runJob,schedule} from '../src/jobs.js';
import {defaultRules,setSetting,storeEvent,storeOfficial,storeSchedule} from '../src/ranking.js';

async function fixture(t) {
  const db=new PGlite();
  t.after(()=>db.close());
  await db.transaction(migrate);
  const {rows:[season]}=await db.query(`INSERT INTO seasons(source_term,legacy_term,starts_on,ends_on)
    VALUES('N','O','2026-10-01','2026-12-31') RETURNING id,starts_on::text,ends_on::text`);
  await db.query('INSERT INTO aggregation_rules(season_id,version,weekly_limit,grade_rules) VALUES($1,1,2,$2)',[season.id,defaultRules]);
  const addEvent=async(eventId,grade='CS',eventDate='2026-10-01')=>{
    const data={eventDate,shopId:1,eventId,heldId:1,name:'大会'+eventId,grade,multiplier:'1',isTeam:false};
    await storeSchedule(db,season,[data]);
    const {rows:[row]}=await db.query('SELECT id FROM events WHERE source_event_id=$1',[eventId]);
    return {...data,...row};
  };
  const pool={query:db.query.bind(db),connect:async()=>({query:db.query.bind(db),release(){}})};
  return {db,season,addEvent,pool};
}

test('candidate upper bound respects weekly top two, GP, cutoff evidence, unknown baseline, and ties',async t=>{
  const {db,season,addEvent}=await fixture(t);
  await storeOfficial(db,season,{time:'2026-11-25T15:02:01+09:00',rows:[
    {dmpId:1,name:'一',rank:201,points:100},{dmpId:2,name:'二',rank:202,points:100},
    {dmpId:3,name:'三',rank:203,points:100},{dmpId:4,name:'四',rank:204,points:100}
  ]});
  await db.query("INSERT INTO players SELECT i,'選手'||i FROM generate_series(100,299) x(i)");
  await db.query(`INSERT INTO provisional_rankings(season_id,dmp_id,rank,points,status,coverage,calculated_at)
    SELECT $1,i,i-99,170,'ready','personal',now() FROM generate_series(100,299) x(i)`,[season.id]);
  await db.query(`INSERT INTO sync_discrepancies(season_id,dmp_id,aggregation_at,official_points,computed_points,status)
    VALUES($1,4,'2026-11-25T15:02:01+09:00',100,100,'match')`,[season.id]);
  const old=await addEvent(1);
  const late='2026-11-25T17:00:00+09:00';
  const score=(dmpId,totalPoints,updatedAt)=>({dmpId,name:'選手'+dmpId,placement:1,totalPoints,updatedAt});
  await storeEvent(db,old,[score(2,120),score(4,50,'2026-10-01T15:00:00+09:00')]);
  await storeEvent(db,old,[score(2,120),score(4,55,late)]);
  const olderLate=await addEvent(2,'CS','2026-10-03');
  await storeEvent(db,olderLate,[score(1,10,late)]);
  for(const [eventId,points,grade] of [[3,30,'CS'],[4,20,'CS'],[5,15,'CS'],[6,10,'GP']]) {
    const event=await addEvent(eventId,grade,'2026-11-26');
    await storeEvent(db,event,[score(1,points),score(3,points),score(5,points)]);
  }
  const decisions=new Map((await candidates(db,season.id)).map(row=>[row.dmp_id,row]));
  assert.equal(decisions.get(1).upper,170);
  assert.equal(decisions.get(1).decision,'qualify-upper-bound');
  assert.equal(decisions.get(2).decision,'hold-no-post-cutoff-evidence');
  assert.equal(decisions.get(3).upper,160);
  assert.equal(decisions.get(3).decision,'below-border');
  assert.equal(decisions.get(4).gain,5);
  assert.equal(decisions.get(5).decision,'hold-no-official-baseline');
});

test('JST cutoff, durable quota with retry, priority promotion and independent traffic limits',async t=>{
  const {db,season,addEvent}=await fixture(t);
  const events=await Promise.all([1,2,3].map(id=>addEvent(id)));
  for(const event of events) await enqueue(db,'event',{season:season.id,id:event.id},'event:'+event.id,4);
  await enqueue(db,'official',{season:season.id},'official',0);
  const configuration={backfillLimit:1};
  const now=new Date('2026-11-25T11:59:59+09:00');
  assert.equal((await claim(db,true,false,{now,configuration})).type,'official');
  assert.equal(await claim(db,true,false,{now,configuration}),undefined);
  await db.query("UPDATE fetch_jobs SET status='done' WHERE type='official'");
  const both=await Promise.all([claim(db,true,false,{now,configuration}),claim(db,true,false,{now,configuration})]);
  assert.equal(both.filter(Boolean).length,1);
  const chosen=both.find(Boolean);
  await db.query("UPDATE fetch_jobs SET status='pending',next_run_at=now() WHERE id=$1",[chosen.id]);
  assert.equal((await claim(db,true,false,{now,configuration})).id,chosen.id);
  assert.equal(await claim(db,true,false,{now,configuration}),undefined);
  await db.query("UPDATE fetch_jobs SET status='done' WHERE id=$1",[chosen.id]);
  assert.equal(await claim(db,true,false,{now:new Date('2026-11-25T12:00:00+09:00'),configuration}),undefined);
  assert.ok(await claim(db,true,false,{now:new Date('2026-11-26T00:00:00+09:00'),configuration}));
  assert.equal((await db.query('SELECT count(*)::int n FROM backfill_daily_events')).rows[0].n,2);
  const {rows:[pending]}=await db.query("SELECT * FROM fetch_jobs WHERE status='pending'");
  await enqueue(db,'event',pending.payload,pending.dedupe_key,0,{reason:'administrator'});
  assert.equal(await claim(db,true,false,{level:3}),undefined);
  assert.equal((await claim(db,true,false,{level:2})).priority,0);
  assert.equal(restriction(.8,.69),1);
  assert.equal(restriction(.91,.95),3);
  assert.equal(restriction(null,.9),2);
  assert.equal((await usage(db)).traffic,null);
  await setSetting(db,'acquisition',{trafficBudget:100,dbBudget:1000});
  await setSetting(db,'database_bytes',900);
  await db.query(`INSERT INTO dmp_traffic_daily VALUES((now() AT TIME ZONE 'Asia/Tokyo')::date,95,now())`);
  assert.equal((await usage(db)).level,3);
  assert.equal((await usage(db)).databaseRate,.9);
});

test('legacy dry-run applies no writes and migration is paused, targeted, and repeatable',async t=>{
  const {db,season,addEvent}=await fixture(t);
  await storeOfficial(db,season,{time:'2026-11-25T00:00:00Z',rows:[{dmpId:1,name:'旧',rank:200,points:100}]});
  await db.query("INSERT INTO players(dmp_id,handle_name) VALUES(2,'保留')");
  await enqueue(db,'personal',{season:season.id,id:1},'personal:'+season.id+':1',20);
  await enqueue(db,'personal',{season:season.id,id:2},'personal:'+season.id+':2',20);
  const event=await addEvent(1,'CS','2026-10-02');
  await db.query("UPDATE events SET event_date=(now() AT TIME ZONE 'Asia/Tokyo')::date-40 WHERE id=$1",[event.id]);
  await enqueue(db,'event',{season:season.id,id:event.id},'event:'+event.id,1);
  await enqueue(db,'complete-personal',{season:season.id},'complete-personal:'+season.id,21);
  await db.query('UPDATE fetch_jobs SET legacy_queue=true');
  assert.equal(await claim(db),undefined);
  const before=(await db.query('SELECT status,priority,legacy_queue FROM fetch_jobs ORDER BY id')).rows;
  const dry=await db.transaction(async tx=>{
    await tx.query('SET TRANSACTION READ ONLY');
    return queueMigration(tx);
  });
  assert.equal(dry.length,4);
  assert.deepEqual((await db.query('SELECT status,priority,legacy_queue FROM fetch_jobs ORDER BY id')).rows,before);
  await assert.rejects(db.transaction(tx=>queueMigration(tx,{apply:true})),/Pause/);
  await setSetting(db,'paused',true);
  await db.transaction(tx=>queueMigration(tx,{apply:true}));
  assert.deepEqual(await db.transaction(tx=>queueMigration(tx,{apply:true})),[]);
  assert.deepEqual((await db.query('SELECT priority,status FROM fetch_jobs ORDER BY id')).rows,[
    {priority:1,status:'pending'},{priority:2,status:'held'},{priority:4,status:'pending'},{priority:2,status:'pending'}
  ]);
});

test('weekly coverage is staggered and skips players with a recent successful full-period fetch',async t=>{
  const {db,season}=await fixture(t);
  const now=new Date('2026-11-25T04:00:00+09:00');
  const bucket=(Math.floor(Date.parse('2026-11-25')/86400000)*12+4)%84;
  const first=bucket+84;
  await db.query('UPDATE seasons SET initialized_at=now() WHERE id=$1',[season.id]);
  for(const id of [first,first+1,first+84]) {
    await db.query("INSERT INTO players(dmp_id,handle_name) VALUES($1,'週次'||$1::int::text)",[id]);
    await db.query("INSERT INTO tracked_players(season_id,dmp_id,reasons,backfill_status) VALUES($1,$2,'{official}','ready')",[season.id,id]);
  }
  await db.query("INSERT INTO personal_fetch_coverage VALUES($1,$2,'2026-11-24T00:00:00Z',$3,'2026-11-24')",[season.id,first+84,season.starts_on]);
  await schedule(db,now);
  await schedule(db,now);
  assert.deepEqual((await db.query("SELECT (payload->>'id')::int id,priority FROM fetch_jobs WHERE type='personal'")).rows,
    [{id:first,priority:3}]);
  await schedule(db,new Date('2026-11-25T05:00:00+09:00'));
  assert.deepEqual((await db.query("SELECT (payload->>'id')::int id FROM fetch_jobs WHERE type='personal' ORDER BY id")).rows,
    [{id:first},{id:first+1}]);
});

test('event cadence escalates by age and historical backfill does not start a frequent refresh cycle',async t=>{
  const {db,season,addEvent,pool}=await fixture(t);
  const {rows:[clock]}=await db.query("SELECT (now() AT TIME ZONE 'Asia/Tokyo')::date::text AS day");
  // The fixture season is tied to the update test date. Move its bounds to the test clock.
  const old=new Date(Date.parse(clock.day)-40*86400000).toISOString().slice(0,10);
  season.starts_on=old;season.ends_on=clock.day;
  await db.query('UPDATE seasons SET starts_on=$2,ends_on=$3 WHERE id=$1',[season.id,old,clock.day]);
  for(const [index,age,expected] of [[1,0,1],[2,24,6],[3,72,24],[4,192,168],[5,744,null],[6,0,null]]) {
    const event=await addEvent(index,'CS',index===6?old:clock.day);
    if(age) await db.query("UPDATE events SET first_fetched_at=now()-$2::int*interval '1 hour' WHERE id=$1",[event.id,age]);
    await enqueue(db,'event',{season:season.id,id:event.id},'event:'+event.id,index===6?4:1);
    const job=await claim(db,true,false,{now:new Date('2026-11-25T00:00:00+09:00')});
    await runJob(pool,job,{client:{event:async()=>[]}});
    assert.equal((await db.query(`SELECT round(extract(epoch FROM next_fetch_at-last_fetched_at)/3600)::int hours
      FROM events WHERE id=$1`,[event.id])).rows[0].hours,expected);
  }
});

test('historical schedule fills only the low-priority event queue and never fetches results inline',async t=>{
  const {db,season,pool}=await fixture(t);
  const {rows:[clock]}=await db.query("SELECT ((now() AT TIME ZONE 'Asia/Tokyo')::date-40)::text AS old");
  await db.query('UPDATE seasons SET starts_on=least(starts_on,$2::date),ends_on=greatest(ends_on,$2::date) WHERE id=$1',[season.id,clock.old]);
  await enqueue(db,'schedule',{season:season.id,grade:'CS',from:clock.old,to:clock.old},'backfill-list:fixture',4);
  const job=await claim(db,true,false,{now:new Date('2026-11-25T00:00:00+09:00')});
  await runJob(pool,job,{client:{schedule:async()=>Array.from({length:130},(_,i)=>({
    eventDate:clock.old,shopId:1,eventId:i+1,heldId:1,name:'履歴大会'+i,grade:'CS',multiplier:'1',isTeam:false
  }))}});
  assert.deepEqual((await db.query("SELECT priority,count(*)::int n FROM fetch_jobs WHERE type='event' GROUP BY priority")).rows,
    [{priority:4,n:130}]);
  assert.equal((await db.query('SELECT count(*)::int n FROM event_results')).rows[0].n,0);
});

test('queue preview works read-only before the schema migration and leaves jobs untouched',async t=>{
  const db=new PGlite();
  t.after(()=>db.close());
  const {readFile}=await import('node:fs/promises');
  for(const migration of ['001','002','003','004','005']) {
    await db.exec(await readFile(new URL('../migrations/'+migration+'.sql',import.meta.url),'utf8'));
  }
  await db.query("INSERT INTO fetch_jobs(type,payload,dedupe_key,priority) VALUES('official','{}','fixture',0)");
  const result=await db.transaction(async tx=>{
    await tx.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
    return queueMigration(tx);
  });
  assert.deepEqual(result.map(row=>[row.type,row.priority,row.status]),[['official',0,'pending']]);
  assert.equal((await db.query('SELECT count(*)::int n FROM fetch_jobs')).rows[0].n,1);
});
