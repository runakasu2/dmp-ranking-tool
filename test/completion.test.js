import {test} from 'node:test';
import assert from 'node:assert/strict';
import {PGlite} from '@electric-sql/pglite';
import {migrate} from '../src/db.js';
import {claim,enqueue,enqueueCompletion,runJob} from '../src/jobs.js';
import {completionProgress} from '../src/completion.js';
import {defaultRules,storeOfficial,storePersonal} from '../src/ranking.js';

test('resumes shared completion from archived personal rows and retains unmatched rows',async()=>{
  const db=new PGlite();
  const pool={query:db.query.bind(db),connect:async()=>({query:db.query.bind(db),release(){}})};
  try {
    await db.transaction(migrate);
    const {rows:[season]}=await db.query("INSERT INTO seasons(source_term,legacy_term,starts_on,ends_on) VALUES('N','O','2020-01-01','2020-12-31') RETURNING id,starts_on::text,ends_on::text");
    await db.query('INSERT INTO aggregation_rules(season_id,version,weekly_limit,grade_rules) VALUES($1,1,2,$2)',[season.id,defaultRules]);
    await storeOfficial(db,season,{time:'2020-12-01T00:00:00Z',rows:[
      {dmpId:1,name:'一',rank:1,points:100},{dmpId:2,name:'二',rank:2,points:50},{dmpId:3,name:'三',rank:3,points:20}
    ]});
    const row=(eventId,totalPoints)=>({eventDate:'2020-01-02',key:{shopId:1,eventId,heldId:1},name:'大会'+eventId,placement:1,totalPoints});
    await storePersonal(db,season,1,[row(1,100),row(3,0)]);
    await storePersonal(db,season,2,[row(1,50)]);
    // Legacy rows from the deployed workflow had no full-history bookkeeping.
    await db.query("DELETE FROM app_settings WHERE key LIKE 'personal-history:%'");
    await enqueue(db,'personal',{season:season.id,id:3},'personal:'+season.id+':3',1);
    await enqueueCompletion(db,season.id);
    await enqueueCompletion(db,season.id);
    const calls=[];
    let additionalEventAvailable=false;
    const client={
      personal:async player=>{calls.push(['personal',player.dmp_id]);return [row(2,20)];},
      schedule:async(grade,from,to)=>{
        calls.push([grade,from,to]);
        const id=grade==='CS'?1:grade==='CSE'&&additionalEventAvailable?2:null;
        return id?[{eventDate:'2020-01-02',shopId:1,eventId:id,heldId:1,name:'大会'+id,grade,multiplier:'1',isTeam:false}]:[];
      }
    };
    await runJob(pool,await claim(db),{client});
    const before=await completionProgress(db,season.id);
    assert.deepEqual([before.fetched,before.matched,before.calculated,before.details,before.events,before.positive],[3,0,0,4,3,3]);
    const local=await claim(db,false);
    assert.equal(local.type,'complete-personal');
    await runJob(pool,local,{client});
    assert.equal(await claim(db,false),undefined);
    while(true) {
      const job=await claim(db);
      if(!job) break;
      await runJob(pool,job,{client});
    }
    assert.deepEqual(calls,[['personal',3],...['CS','CSE','GP','BN'].map(grade=>[grade,'2020-01-01','2020-01-05'])]);
    const after=await completionProgress(db,season.id);
    assert.deepEqual([after.fetched,after.matched,after.calculated,after.details,after.events,after.positive],[3,2,2,2,2,1]);
    assert.deepEqual((await db.query('SELECT dmp_id,points FROM provisional_rankings ORDER BY dmp_id')).rows,[{dmp_id:1,points:100},{dmp_id:2,points:50}]);
    assert.deepEqual((await db.query("SELECT type,count(*)::int n FROM fetch_jobs GROUP BY type ORDER BY type")).rows,
      [{type:'complete-personal',n:1},{type:'complete-schedule',n:4},{type:'personal',n:1}]);
    await enqueueCompletion(db,season.id);
    await runJob(pool,await claim(db),{client});
    assert.equal(await claim(db),undefined);
    assert.equal((await db.query('SELECT count(*)::int n FROM event_results')).rows[0].n,2);
    additionalEventAvailable=true;
    await db.query("UPDATE fetch_jobs SET next_run_at=now() WHERE type='complete-schedule'");
    await enqueueCompletion(db,season.id);
    while(true) {
      const job=await claim(db);
      if(!job) break;
      await runJob(pool,job,{client});
    }
    const final=await completionProgress(db,season.id);
    assert.deepEqual([final.matched,final.calculated,final.details,final.positive],[3,3,1,0]);
    assert.ok((await db.query('SELECT initialized_at FROM seasons')).rows[0].initialized_at);
    assert.deepEqual(calls.filter(call=>call[0]==='personal'),[['personal',3]]);
  } finally {await db.close();}
});

test('batch replay preserves conflicts, authoritative results, change history and rollback',async()=>{
  const db=new PGlite();
  const {storeSchedule,storeEvent,replayPendingPersonal}=await import('../src/ranking.js');
  try{
    await db.transaction(migrate);
    const {rows:[season]}=await db.query("INSERT INTO seasons(source_term,legacy_term,starts_on,ends_on) VALUES('N','O','2020-01-01','2020-12-31') RETURNING id,starts_on::text,ends_on::text");
    await storeOfficial(db,season,{time:'2020-12-01T00:00:00Z',rows:[{dmpId:1,name:'一',rank:1,points:10},{dmpId:2,name:'二',rank:2,points:40}]});
    const events=[1,2,3].map(eventId=>({eventDate:'2020-01-02',shopId:1,eventId,heldId:1,name:'大会',grade:'CS',multiplier:'1',isTeam:false}));
    await storeSchedule(db,season,events);
    const {rows:[authoritative]}=await db.query('SELECT id FROM events WHERE source_event_id=2');
    await storeEvent(db,authoritative,[{dmpId:2,name:'二',placement:1,totalPoints:40}]);
    const add=(p,k,eventId,totalPoints)=>db.query('INSERT INTO pending_personal_results VALUES($1,$2,$3,$4)',
      [season.id,p,k,{eventDate:'2020-01-02',key:{shopId:1,eventId,heldId:1},placement:1,totalPoints}]);
    await add(1,'one',1,10);
    await add(1,'same',1,10);
    await add(1,'conflict-a',3,20);
    await add(1,'conflict-b',3,30);
    await add(2,'authoritative',2,1);
    const fail=new Error('Injected rollback');
    await assert.rejects(db.transaction(async tx=>{await replayPendingPersonal(tx,season.id);throw fail;}),fail);
    assert.equal((await db.query('SELECT count(*)::int n FROM pending_personal_results')).rows[0].n,5);
    const affected=await db.transaction(tx=>replayPendingPersonal(tx,season.id));
    assert.deepEqual(affected,[1,2]);
    assert.deepEqual((await db.query('SELECT total_points FROM event_results ORDER BY dmp_id')).rows.map(r=>r.total_points),[10,40]);
    assert.deepEqual((await db.query('SELECT event_key FROM pending_personal_results ORDER BY event_key')).rows.map(r=>r.event_key),['conflict-a','conflict-b']);
    assert.deepEqual(await db.transaction(tx=>replayPendingPersonal(tx,season.id)),[]);
    const history=(await db.query('SELECT changed_fields FROM event_result_changes ORDER BY id')).rows;
    assert.equal(history.length,2);
    assert.deepEqual(history[1].changed_fields.total_points,{before:null,after:10});
  }finally{await db.close();}
});
