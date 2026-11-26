import {test,after} from 'node:test';
import assert from 'node:assert/strict';
import {PGlite} from '@electric-sql/pglite';
import {migrate} from '../src/db.js';
import {claimAcquisition,enqueue,runJob} from '../src/jobs.js';
import {defaultRules,setSetting,storeSchedule} from '../src/ranking.js';

const db=new PGlite();
const pool={query:db.query.bind(db),connect:async()=>({query:db.query.bind(db),release(){}})};
const virtualMorning=new Date('2026-11-25T06:00:00+09:00');
const getJob=()=>claimAcquisition(pool,true,virtualMorning);
const ready=db.transaction(migrate);
after(async()=>{await ready;await db.close();});
const q=async(sql,args)=>(await db.query(sql,args)).rows;
const ledger=()=>q('SELECT event_id,reservation_token FROM backfill_daily_events ORDER BY event_id');
const noNetwork=()=>assert.fail('HTTP must remain suppressed');
async function run(job,fetcher) {
  const saved=process.env.ALLOW_DMP_FETCH;
  process.env.ALLOW_DMP_FETCH='true';
  try {await runJob(pool,job,{fetcher,now:()=>virtualMorning});}
  finally {
    if(saved===undefined) delete process.env.ALLOW_DMP_FETCH;
    else process.env.ALLOW_DMP_FETCH=saved;
  }
}
async function fixture(count=1) {
  await ready;
  await q('DELETE FROM backfill_daily_events');
  await q('DELETE FROM fetch_jobs');
  await q('DELETE FROM dmp_traffic_daily');
  await q('DELETE FROM app_settings');
  await q('DELETE FROM event_result_changes');
  await q('DELETE FROM event_results');
  await q('DELETE FROM events');
  await q('DELETE FROM weekly_points');
  await q('DELETE FROM aggregation_rules');
  await q('DELETE FROM seasons');
  const [season]=await q(`INSERT INTO seasons(source_term,legacy_term,starts_on,ends_on)
    VALUES('N','O','2026-10-01','2026-12-31') RETURNING id,starts_on::text,ends_on::text`);
  await q('INSERT INTO aggregation_rules(season_id,version,weekly_limit,grade_rules) VALUES($1,1,2,$2)',[season.id,defaultRules]);
  await storeSchedule(db,season,Array.from({length:count},(_,i)=>({
    eventId:i+1,eventDate:'2026-10-02',shopId:1,heldId:1,name:'fixture',grade:'CS',multiplier:1,isTeam:false
  })));
  await q(`INSERT INTO fetch_jobs(type,payload,dedupe_key,priority)
    SELECT 'event',jsonb_build_object('season',season_id,'id',id),'event:'||id,4 FROM events ORDER BY id`);
}
const state=async id=>(await q('SELECT status,attempts,checkpoint FROM fetch_jobs WHERE id=$1',[id]))[0];
const due=async id=>q("UPDATE fetch_jobs SET next_run_at=now()-interval '1 second' WHERE id=$1",[id]);
const response=rows=>Response.json({d:JSON.stringify(rows)});

test('cooldown leaves 55 queued events untouched, while local work still runs',async()=>{
  await fixture(55);
  await setSetting(db,'dmp_next_request',Date.now()+60000);
  for(let i=0;i<3;i++) assert.equal(await getJob(),undefined);
  assert.deepEqual(await ledger(),[]);
  assert.deepEqual(await q("SELECT count(*)::int n FROM fetch_jobs WHERE status='pending' AND attempts=0"),[{n:55}]);
  await enqueue(db,'maintenance',{},'local-only',0);
  const local=await getJob();
  assert.equal(local.type,'maintenance');
  await run(local,noNetwork);
  assert.equal((await state(local.id)).status,'done');
  await setSetting(db,'dmp_next_request',Date.now()-1000);
  const resumed=await getJob();
  assert.equal(resumed.priority,4);
  await run(resumed,()=>response([]));
  assert.deepEqual(await ledger(),[{event_id:resumed.payload.id,reservation_token:null}]);
});

test('a second worker receiving 429 after the P4 claim releases the unused reservation without counting a failure',async()=>{
  await fixture(2);
  const first=await getJob();
  const second=await getJob();
  assert.equal((await ledger()).length,2);
  await run(first,()=>new Response('',{status:429,headers:{'retry-after':'60'}}));
  await run(second,noNetwork);
  assert.equal((await state(first.id)).attempts,1);
  assert.equal((await state(second.id)).attempts,0);
  assert.equal((await state(second.id)).status,'pending');
  assert.deepEqual(await ledger(),[{event_id:first.payload.id,reservation_token:null}]);
  assert.equal(await getJob(),undefined);
  await setSetting(db,'dmp_next_request',Date.now()-1000);
  await due(second.id);
  const resumed=await getJob();
  assert.equal(resumed.id,second.id);
  await run(resumed,()=>response([]));
});

test('a sent network failure and subsequent event pages share one consumed slot',async()=>{
  await fixture();
  const job=await getJob();
  const starts=[];
  const offsets=[];
  const mock=(_,options)=>{
    starts.push(performance.now());
    const {offset,shopID,eventID,heldID}=JSON.parse(options.body);
    offsets.push(offset);
    if(starts.length===2) throw new TypeError('mock connection lost');
    return response(offset===60?[]:[{ShopID:shopID,EventID:eventID,HeldID:heldID,
      MemberID:offset+1,Rank:offset+1,HandleName:'p'+offset,RankPoint:'10',JudgePoint:'0'}]);
  };
  await run(job,mock);
  const interrupted=await state(job.id);
  assert.equal(interrupted.status,'pending');
  assert.equal(interrupted.attempts,1);
  assert.equal(interrupted.checkpoint.offset,30);
  assert.deepEqual(await q('SELECT count(*)::int n FROM event_results'),[{n:0}]);
  await due(job.id);
  await run(await getJob(),mock);
  assert.equal((await state(job.id)).status,'done',JSON.stringify(await q('SELECT status,error FROM fetch_logs ORDER BY id')));
  assert.deepEqual(offsets,[0,30,30,60]);
  assert.ok(starts.slice(1).every((time,i)=>time-starts[i]>=1000));
  assert.deepEqual(await ledger(),[{event_id:job.payload.id,reservation_token:null}]);
});

test('pause, capacity and disabling backfill after claim leave attempts and quota unchanged',async()=>{
  await fixture();
  let job=await getJob();
  for(const [key,value,reset] of [
    ['paused',true,false],['database_bytes',400000000,0],['acquisition',{backfillEnabled:false},{}]
  ]) {
    await setSetting(db,key,value);
    await run(job,noNetwork);
    assert.equal((await state(job.id)).attempts,0);
    assert.deepEqual(await ledger(),[]);
    await setSetting(db,key,reset);
    await due(job.id);
    job=await getJob();
  }
});

test('lease expiry during cooldown preserves an uncertain prior reservation without allowing a stale owner to refund it',async()=>{
  await fixture(2);
  await setSetting(db,'acquisition',{backfillLimit:1});
  const stale=await getJob();
  await setSetting(db,'dmp_next_request',Date.now()+60000);
  await q("UPDATE fetch_jobs SET lease_until=now()-interval '1 minute' WHERE id=$1",[stale.id]);
  assert.equal(await getJob(),undefined);
  assert.equal((await ledger())[0].reservation_token,stale.lease_token);
  await setSetting(db,'dmp_next_request',Date.now()-1000);
  const replacement=await getJob();
  assert.equal(replacement.id,stale.id);
  assert.notEqual(replacement.lease_token,stale.lease_token);
  await run(stale,noNetwork);
  assert.deepEqual(await ledger(),[{event_id:stale.payload.id,reservation_token:null}]);
  assert.equal(await getJob(),undefined);
  await run(replacement,()=>response([]));
  assert.equal(await getJob(),undefined);
});

test('a still-owned pre-send reservation can be returned on expiry before a replacement claims it',async()=>{
  await fixture();
  const job=await getJob();
  await q("UPDATE fetch_jobs SET lease_until=now()-interval '1 minute' WHERE id=$1",[job.id]);
  await run(job,noNetwork);
  assert.deepEqual(await ledger(),[]);
  assert.equal((await state(job.id)).attempts,0);
});
