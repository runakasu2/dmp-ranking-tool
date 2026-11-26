import {test} from 'node:test';
import assert from 'node:assert/strict';
import {PGlite} from '@electric-sql/pglite';
import {migrate} from '../src/db.js';
import {claim,enqueue,renewLease,runJob,slots} from '../src/jobs.js';
import {defaultRules,storeSchedule} from '../src/ranking.js';
test('JST high-frequency schedule has 68 distinct slots and Wednesday clock has 5 minute peak',()=>{
  const start=Date.parse('2026-11-25T00:00:00+09:00');
  const day=Array.from({length:1440},(_,i)=>slots(new Date(start+i*60000)));
  assert.equal(new Set(day.map(slot=>slot.high)).size,68);
  assert.equal(day[907].official,'2026-11-25T15:05');
  assert.equal(day[1099].official,'2026-11-25T18:15');
});
test('queue dedupes concurrent claims and resumes partial event without publishing partial data',async()=>{
  const sql=new PGlite();
  const pool={query:sql.query.bind(sql),connect:async()=>({query:sql.query.bind(sql),release(){}})};
  try {
    await sql.transaction(migrate);
    const {rows:[season]}=await sql.query("INSERT INTO seasons(source_term,legacy_term,starts_on,ends_on) VALUES('N','O','2026-11-01','2026-12-31') RETURNING id,starts_on::text,ends_on::text");
    await sql.query('INSERT INTO aggregation_rules(season_id,version,weekly_limit,grade_rules) VALUES($1,1,2,$2)',[season.id,defaultRules]);
    await storeSchedule(sql,season,[{eventDate:'2026-11-16',shopId:1,eventId:1,heldId:1,name:'匿名',grade:'CS',multiplier:'1',isTeam:false}]);
    await enqueue(sql,'event',{season:season.id,id:1},'event:1',1);
    await enqueue(sql,'event',{season:season.id,id:1},'event:1',1);
    const [job,duplicate]=await Promise.all([claim(sql),claim(sql)]);
    assert.ok(job);
    assert.equal(duplicate,undefined);
    const offsets=[];
    const client={event:async(key,offset)=>{
      offsets.push(offset);
      if(offset===0) return [{dmpId:1,name:'匿名',placement:1,totalPoints:50}];
      if(offsets.length===2) throw new Error('Interrupted');
      return [];
    }};
    await runJob(pool,job,{client});
    assert.equal((await sql.query('SELECT * FROM event_results')).rows.length,0);
    await sql.query("UPDATE fetch_jobs SET next_run_at=now() WHERE type='event'");
    await runJob(pool,await claim(sql),{client});
    assert.deepEqual(offsets,[0,30,30]);
    assert.equal((await sql.query('SELECT total_points FROM event_results')).rows[0]?.total_points,50);
  } finally {await sql.close();}
});
test('expired leases are reclaimed, stale workers are fenced, and Retry-After persists',async()=>{
  const sql=new PGlite();
  const pool={query:sql.query.bind(sql),connect:async()=>({query:sql.query.bind(sql),release(){}})};
  try {
    await sql.transaction(migrate);
    const {rows:[season]}=await sql.query("INSERT INTO seasons(source_term,legacy_term,starts_on,ends_on) VALUES('N','O','2026-11-01','2026-12-31') RETURNING id");
    await enqueue(sql,'official',{season:season.id},'official-test',0);
    assert.equal(await claim(sql,false),undefined);
    const first=await claim(sql);
    await sql.query("UPDATE fetch_jobs SET lease_until=now()-interval '1 minute'");
    const second=await claim(sql);
    assert.notEqual(first.lease_token,second.lease_token);
    assert.equal(await renewLease(sql,first),false);
    await sql.query("UPDATE fetch_jobs SET lease_until=clock_timestamp()+interval '5 seconds'");
    assert.equal(await renewLease(sql,second),true);
    assert.equal(await claim(sql),undefined);
    const {rows:[renewal]}=await sql.query("SELECT lease_until>clock_timestamp()+interval '90 seconds' AS extended FROM fetch_jobs");
    assert.equal(renewal.extended,true);
    const time=Date.now()+90000;
    const client={official:async()=>{throw Object.assign(new Error('DMP HTTP 429'),{retryAt:time});}};
    await runJob(pool,first,{client});
    assert.equal((await sql.query('SELECT attempts FROM fetch_jobs')).rows[0].attempts,0);
    await runJob(pool,second,{client});
    const {rows:[next]}=await sql.query('SELECT next_run_at,attempts,last_error,started_at,finished_at FROM fetch_jobs');
    assert.equal(+new Date(next.next_run_at),time);
    assert.equal(next.attempts,1);
    assert.equal(next.last_error,'DMP HTTP 429');
    assert.ok(+new Date(next.finished_at)>=+new Date(next.started_at));
    const {rows:[log]}=await sql.query('SELECT phase_ms FROM fetch_logs');
    assert.ok(Object.hasOwn(log.phase_ms,'official_fetch'));
    assert.ok((await sql.query("SELECT value FROM app_settings WHERE key='dmp_next_request'")).rows[0].value>=time);
  } finally {await sql.close();}
});


test('the worker detects a decoded-name collision using other stored DMP IDs',async()=>{
  const sql=new PGlite();
  const pool={query:sql.query.bind(sql),connect:async()=>({query:sql.query.bind(sql),release(){}})};
  try {
    await sql.transaction(migrate);
    const {rows:[season]}=await sql.query("INSERT INTO seasons(source_term,legacy_term,starts_on,ends_on) VALUES('N','O','2026-11-01','2026-12-31') RETURNING id");
    await sql.query("INSERT INTO players(dmp_id,handle_name) VALUES(1,'試験選手C&#128167;'),(2,'試験選手C💧')");
    await enqueue(sql,'personal',{season:season.id,id:1},'identity-test',0);
    const client={personal:async (player,_,__,options)=>{
      assert.equal(await options.nameCollision('試験選手C💧'),true);
      return [];
    }};
    await runJob(pool,await claim(sql),{client});
    const {rows:[job]}=await sql.query('SELECT last_error FROM fetch_jobs');
    assert.match(job.last_error,/invalid or ambiguous name/);
    assert.equal((await sql.query('SELECT count(*)::int n FROM event_results')).rows[0].n,0);
  } finally {await sql.close();}
});
