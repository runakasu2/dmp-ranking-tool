import {test} from 'node:test';
import assert from 'node:assert/strict';
import {PGlite} from '@electric-sql/pglite';
import {migrate} from '../src/db.js';
import {candidatePreview,candidates} from '../src/acquisition.js';
import {claimAcquisition,dispatchDmpRequest,enqueue,enqueueCandidatePreview,runJob,schedule} from '../src/jobs.js';
import {defaultRules,setSetting,storeEvent,storeSchedule} from '../src/ranking.js';

async function fixture(t) {
  const db=new PGlite();
  t.after(()=>db.close());
  await db.transaction(migrate);
  const query=db.query.bind(db),pool={query,connect:async()=>({query,release(){}})};
  const q=async(sql,args)=>(await query(sql,args)).rows;
  const [season]=await q("INSERT INTO seasons(source_term,legacy_term,starts_on,ends_on) VALUES('N','O','2026-10-01','2026-12-31') RETURNING id,starts_on::text,ends_on::text");
  await q('INSERT INTO aggregation_rules(season_id,version,weekly_limit,grade_rules) VALUES($1,1,2,$2)',[season.id,defaultRules]);
  const make=async(id,eventDate='2026-10-02')=>{
    const event={eventId:id,eventDate,shopId:1,heldId:1,name:'fixture',grade:'CS',multiplier:1,isTeam:false};
    await storeSchedule(db,season,[event]);
    const [row]=await q('SELECT id FROM events WHERE source_event_id=$1',[id]);
    return {...event,...row};
  };
  return {db,pool,q,season,make};
}
const time=value=>new Date('2026-11-25T'+value+'+09:00');

test('paused cron retains old work; resumptions dedupe exact ranges and catch up the missed weekly slot',async t=>{
  const {db,q,season}=await fixture(t);
  const scheduleAt=at=>db.transaction(tx=>schedule(tx,time(at)));
  const sid=season.id;
  await q("UPDATE seasons SET initialized_at='2026-11-01' WHERE id=$1",[sid]);
  await q("INSERT INTO players(dmp_id,handle_name) VALUES(42,'fixture')");
  await q("INSERT INTO tracked_players(season_id,dmp_id,reasons,backfill_status) VALUES($1,42,'{official}','ready')",[sid]);
  await q("INSERT INTO personal_fetch_coverage VALUES($1,42,'2026-11-03',$2,'2026-11-03')",[sid,season.starts_on]);
  await setSetting(db,'paused',true);
  await scheduleAt('04:00:00');
  assert.deepEqual(await q('SELECT type FROM fetch_jobs'),[{type:'maintenance'}]);
  await setSetting(db,'paused',false);
  await scheduleAt('04:00:00');
  await scheduleAt('05:00:00');
  assert.deepEqual(await q("SELECT count(*)::int n FROM fetch_jobs WHERE type='personal'"),[{n:1}]);
  const where="type='schedule' AND payload->>'grade'='CS' AND payload->>'from'='2026-11-18' AND payload->>'to'='2026-11-25'";
  assert.deepEqual(await q('SELECT count(*)::int n FROM fetch_jobs WHERE '+where),[{n:1}]);
  await q("UPDATE fetch_jobs SET status='done',finished_at='2026-11-25T05:15:00+09:00' WHERE "+where);
  await scheduleAt('05:30:00');
  assert.deepEqual(await q('SELECT count(*)::int n FROM fetch_jobs WHERE '+where),[{n:1}]);
  await scheduleAt('06:00:00');
  assert.deepEqual(await q('SELECT count(*)::int n FROM fetch_jobs WHERE '+where),[{n:2}]);
  assert.ok((await q("SELECT 1 FROM fetch_jobs WHERE type='schedule' AND payload->>'grade'='CS' AND payload->>'from'='2026-11-11'")).length);
});

test('noon suppresses a first dispatch without charges; later pages can continue',async t=>{
  const {db,pool,season,make,q}=await fixture(t);
  const event=await make(1);
  await enqueue(db,'event',{season:season.id,id:event.id},'event:'+event.id,4);
  const job=await claimAcquisition(pool,true,time('11:59:59'));
  const saved=process.env.ALLOW_DMP_FETCH;
  process.env.ALLOW_DMP_FETCH='true';
  let sent=0;
  try {
    await runJob(pool,job,{now:()=>time('12:00:00'),fetcher:()=>{sent++;return Response.json({});}});
  } finally {
    if(saved===undefined) delete process.env.ALLOW_DMP_FETCH;
    else process.env.ALLOW_DMP_FETCH=saved;
  }
  assert.equal(sent,0);
  assert.deepEqual(await q('SELECT attempts,status FROM fetch_jobs'),[{attempts:0,status:'pending'}]);
  assert.deepEqual(await q('SELECT * FROM backfill_daily_events'),[]);
  await q("UPDATE fetch_jobs SET next_run_at=now()");
  const leased=await claimAcquisition(pool,true,time('11:59:59'));
  await dispatchDmpRequest(pool,leased,()=>++sent,{now:()=>time('11:59:59')});
  await dispatchDmpRequest(pool,leased,()=>++sent,{first:false,now:()=>time('12:00:00')});
  assert.equal(sent,2);
});

test('a P4 job yields after saving the page and resumes the stored offset after normal work',async t=>{
  const {db,pool,q,season,make}=await fixture(t);
  const event=await make(1);
  await enqueue(db,'event',{season:season.id,id:event.id},'event:'+event.id,4);
  const job=await claimAcquisition(pool,true,time('06:00:00'));
  const offsets=[];
  const client={event:async(_,offset)=>{
    offsets.push(offset);
    if(offset===0) {
      await enqueue(db,'official',{season:season.id},'normal',0);
      return [{dmpId:33,name:'fixture',placement:1,totalPoints:30}];
    }
    return [];
  }};
  await runJob(pool,job,{client});
  assert.deepEqual(offsets,[0]);
  const [partial]=await q("SELECT checkpoint,attempts,status FROM fetch_jobs WHERE id=$1",[job.id]);
  assert.equal(partial.checkpoint.offset,30);
  assert.equal(partial.attempts,0);
  assert.equal(partial.status,'pending');
  assert.deepEqual(await q('SELECT * FROM event_results'),[]);
  const normal=await claimAcquisition(pool,true,time('06:00:00'));
  assert.equal(normal.priority,0);
  await runJob(pool,normal,{client:{official:async()=>null}});
  await q("UPDATE fetch_jobs SET next_run_at=now() WHERE id=$1",[job.id]);
  await runJob(pool,await claimAcquisition(pool,true,time('06:00:00')),{client});
  assert.deepEqual(offsets,[0,30]);
  assert.deepEqual(await q('SELECT total_points FROM event_results'),[{total_points:30}]);
});

test('unlisted historical scores and verified weekly replacement, plus preview and candidate quota',async t=>{
  const {db,pool,q,season,make}=await fixture(t);
  const sid=season.id;
  await q("INSERT INTO players(dmp_id,handle_name) SELECT i,'player'||i FROM generate_series(1,205) i");
  await q(`INSERT INTO provisional_rankings SELECT $1,i,i-5,170,'tracked-only','ready',now()
    FROM generate_series(6,205) i`,[sid]);
  await q("INSERT INTO official_rankings(season_id,dmp_id,rank,points,aggregation_at) VALUES($1,3,203,165,'2026-11-25T15:00:00+09:00')",[sid]);
  await q("INSERT INTO sync_discrepancies(season_id,dmp_id,aggregation_at,official_points,computed_points,status) VALUES($1,3,'2026-11-25T15:00:00+09:00',165,165,'match')",[sid]);
  for(const [id,day,points] of [[1,'2026-11-23',100],[2,'2026-11-24',65],[3,'2026-11-24',40]]){
    const e=await make(id,day);
    const scores=[[1,id===1?100:70],[2,id===1?120:80],[3,points]];
    await storeEvent(db,e,scores.map(([dmpId,totalPoints])=>({
      dmpId,name:'player'+dmpId,placement:dmpId,totalPoints,updatedAt:'2026-11-24T10:00:00+09:00'
    })));
    if(id===3) await storeEvent(db,e,[{dmpId:3,name:'player3',placement:3,totalPoints:75,updatedAt:'2026-11-25T16:00:00+09:00'}]);
  }
  const rows=await candidates(db,sid,[1,2,3]);
  assert.equal(rows.find(r=>r.dmp_id===1).decision,'qualify-known-results');
  assert.equal(rows.find(r=>r.dmp_id===1).known,170);
  assert.equal(rows.find(r=>r.dmp_id===3).gain,10);
  await setSetting(db,'acquisition',{candidateLimit:1});
  let view;
  await db.transaction(async tx=>{
    await tx.query('SET TRANSACTION READ ONLY');
    view=await candidatePreview(tx,sid);
  });
  assert.equal(view.selected[0].dmp_id,2);
  assert.deepEqual(await q('SELECT * FROM fetch_jobs'),[]);
  assert.deepEqual(await db.transaction(tx=>enqueueCandidatePreview(tx,sid)),{registered:1});
  assert.deepEqual(await db.transaction(tx=>enqueueCandidatePreview(tx,sid)),{registered:0});
  const claimed=await claimAcquisition(pool,true,time('06:00:00'));
  await dispatchDmpRequest(pool,claimed,()=>true);
  assert.deepEqual(await q('SELECT dmp_id,reservation_token FROM candidate_daily_players'),[{dmp_id:2,reservation_token:null}]);
  await enqueue(db,'personal',{season:sid,id:1},'candidate:other',2,{reason:'border-candidate'});
  assert.equal(await claimAcquisition(pool,true,time('06:00:00')),undefined);
  assert.equal((await claimAcquisition(pool,true,new Date('2026-11-26T06:00:00+09:00'))).payload.id,1);
});

test('resume splits 550 saved first fetches at seven JST days, without promoting 580 existing P4 jobs',async t=>{
  const {db,season,q,make}=await fixture(t);
  const sid=season.id;
  await storeSchedule(db,season,Array.from({length:1130},(_,i)=>({
    eventId:i+1,eventDate:i<580?'2026-10-02':i<973?'2026-11-17':'2026-11-18',
    shopId:1,heldId:1,name:'fixture',grade:'CS',multiplier:1,isTeam:false
  })));
  await q(`INSERT INTO fetch_jobs(type,payload,dedupe_key,priority,reason)
    SELECT 'event',jsonb_build_object('season',season_id,'id',id),'event:'||id,4,'historical-event'
    FROM events WHERE source_event_id<=580`);
  for(const at of ['16:00:00','17:00:00','18:00:00']) await db.transaction(tx=>schedule(tx,time(at)));
  assert.deepEqual(await q("SELECT priority,count(*)::int n FROM fetch_jobs WHERE type='event' GROUP BY priority ORDER BY priority"),
    [{priority:1,n:157},{priority:4,n:973}]);
  assert.deepEqual(await q("SELECT count(*)::int n FROM fetch_jobs WHERE type='tracking'"),[{n:1}]);
  const changed=await make(1);
  await storeSchedule(db,season,[{...changed,multiplier:2}]);
  const old={eventId:1131,eventDate:'2026-10-02',shopId:1,heldId:1,name:'registered later',grade:'CS',multiplier:null,isTeam:false};
  await storeSchedule(db,season,[old]);
  await storeSchedule(db,season,[{...old,multiplier:1}]);
  await db.transaction(tx=>schedule(tx,time('18:10:00')));
  assert.deepEqual(await q("SELECT priority,count(*)::int n FROM fetch_jobs WHERE reason='event-change' GROUP BY priority"),[{priority:1,n:2}]);
});

test('queue review preserves IDs, checkpoints and logs; tracking follow-up is persistent and coalesces',async t=>{
  const {db,pool,season,q,make}=await fixture(t);
  const {queueReview}=await import('../src/acquisition.js');
  const {reevaluateEventPlayers}=await import('../src/jobs.js');
  const event=await make(1);
  await enqueue(db,'event',{season:season.id,id:event.id},'event:'+event.id,1,{reason:'event-first'});
  const [eventJob]=await q("UPDATE fetch_jobs SET attempts=2,checkpoint='{\"offset\":30}' WHERE type='event' RETURNING id");
  await q("INSERT INTO job_event_pages VALUES($1,0,'[]','fixture-page')",[eventJob.id]);
  await q("INSERT INTO fetch_logs(job_id,status,error) VALUES($1,'pending','fixture-failure')",[eventJob.id]);
  await enqueue(db,'tracking',{season:season.id},'tracking:first',2);
  await enqueue(db,'tracking',{season:season.id},'tracking:ignored',2);
  await q("INSERT INTO fetch_jobs(type,payload,dedupe_key,priority) SELECT type,payload,'tracking:legacy-duplicate',priority FROM fetch_jobs WHERE type='tracking'");
  await assert.rejects(db.transaction(tx=>queueReview(tx,{apply:true})),error=>error.status===409);
  await setSetting(db,'paused',true);
  const review=await db.transaction(async tx=>{
    await tx.query('SET TRANSACTION READ ONLY');
    return queueReview(tx);
  });
  assert.equal(review.demoted,1);
  assert.equal(review.duplicates.length,1);
  assert.equal((await q('SELECT priority FROM fetch_jobs WHERE id=$1',[eventJob.id]))[0].priority,1);
  await db.transaction(tx=>queueReview(tx,{apply:true}));
  assert.deepEqual(await q("SELECT priority,attempts,checkpoint FROM fetch_jobs WHERE id=$1",[eventJob.id]),
    [{priority:4,attempts:2,checkpoint:{offset:30}}]);
  assert.equal((await q('SELECT * FROM job_event_pages')).length,1);
  assert.equal((await q('SELECT * FROM fetch_logs')).length,1);
  assert.deepEqual(await q("SELECT status FROM fetch_jobs WHERE dedupe_key='tracking:legacy-duplicate'"),[{status:'cancelled'}]);
  await setSetting(db,'paused',false);
  const tracking=await claimAcquisition(pool,false,time('15:00:00'));
  assert.equal(tracking.type,'tracking');
  await assert.rejects(db.transaction(tx=>queueReview(tx,{apply:true})),error=>error.status===409);
  await db.transaction(tx=>reevaluateEventPlayers(tx,season,[101]));
  await db.transaction(tx=>reevaluateEventPlayers(tx,season,[101,102]));
  assert.deepEqual((await q("SELECT value FROM app_settings WHERE key LIKE 'tracking-dirty:%'"))[0].value,[101,102]);
  await runJob(pool,tracking);
  const followup=await claimAcquisition(pool,false,time('15:00:00'));
  assert.ok(followup.payload.dirty);
  await runJob(pool,followup);
  assert.deepEqual(await q("SELECT value FROM app_settings WHERE key LIKE 'tracking-dirty:%'"),[]);
  assert.equal(await claimAcquisition(pool,false,time('15:00:00')),undefined);
});

test('malformed page holds the job without updating points and manual requeue can resume the checkpoint',async t=>{
  const {db,pool,season,q,make}=await fixture(t);
  const event=await make(1);
  await enqueue(db,'event',{season:season.id,id:event.id},'event:'+event.id,1);
  const saved=process.env.ALLOW_DMP_FETCH;
  process.env.ALLOW_DMP_FETCH='true';
  let malformed=true;
  const offsets=[];
  const fetcher=(_,options)=>{
    const {offset}=JSON.parse(options.body);
    offsets.push(offset);
    return Response.json({d:JSON.stringify(offset===60?[]:[{ShopID:1,EventID:1,HeldID:1,
      MemberID:offset+1,Rank:offset===30&&malformed?'X':offset+1,HandleName:'fixture',RankPoint:'10',JudgePoint:'0'}])});
  };
  try {
    const first=await claimAcquisition(pool,true,time('14:00:00'));
    await runJob(pool,first,{fetcher});
    const [held]=await q('SELECT status,checkpoint,last_error FROM fetch_jobs WHERE id=$1',[first.id]);
    assert.equal(held.status,'held');
    assert.equal(held.checkpoint.offset,30);
    assert.match(held.last_error,/event=1\/1\/1 offset=30 \[placement\]/);
    assert.deepEqual(await q('SELECT * FROM event_results'),[]);
    assert.equal(await claimAcquisition(pool,true,time('14:00:00')),undefined);
    malformed=false;
    await enqueue(db,'event',{season:season.id,id:event.id},'event:'+event.id,0,{reopen:true,reason:'administrator'});
    await runJob(pool,await claimAcquisition(pool,true,time('14:00:00')),{fetcher});
    assert.deepEqual(offsets,[0,30,30,60]);
    assert.equal((await q("SELECT status FROM fetch_jobs WHERE id=$1",[first.id]))[0].status,'done');
  } finally {
    if(saved===undefined) delete process.env.ALLOW_DMP_FETCH;
    else process.env.ALLOW_DMP_FETCH=saved;
  }
});

test('held blank rank can re-enter the queue while preserving history and completing across zero-point pages',async t=>{
  const {db,pool,season,q,make}=await fixture(t);
  const {heldResultReview}=await import('../src/acquisition.js');
  const event=await make(1);
  await enqueue(db,'event',{season:season.id,id:event.id},'event:'+event.id,1);
  const [j]=await q(`UPDATE fetch_jobs SET status='held',attempts=1,last_error='Invalid integer event=1/1/1 offset=30 [placement] value=""',
    checkpoint='{"signature":"[\\"2026-10-02\\",\\"1\\"]","offset":30}' WHERE type='event' RETURNING id`);
  await q(`INSERT INTO job_event_pages VALUES($1,0,'[{"dmpId":99,"name":"fixture-old","placement":1,"totalPoints":50}]','kept')`,[j.id]);
  await q("INSERT INTO fetch_logs(job_id,status,error) VALUES($1,'held','legacy')",[j.id]);
  await setSetting(db,'paused',true);
  const preview=await db.transaction(async tx=>{await tx.query('SET TRANSACTION READ ONLY');return heldResultReview(tx,season.id);});
  assert.equal(preview.retry,1);
  assert.equal((await q('SELECT status FROM fetch_jobs'))[0].status,'held');
  await db.transaction(tx=>heldResultReview(tx,season.id,{apply:true}));
  assert.deepEqual(await q("SELECT status,attempts,checkpoint->>'offset' AS offset FROM fetch_jobs"),[{status:'pending',attempts:1,offset:'30'}]);
  await setSetting(db,'paused',false);
  const saved=process.env.ALLOW_DMP_FETCH;
  process.env.ALLOW_DMP_FETCH='true';
  const offsets=[];
  try {
    const job=await claimAcquisition(pool,true,time('14:00:00'));
    await runJob(pool,job,{fetcher:(_,options)=>{
      const {offset}=JSON.parse(options.body);offsets.push(offset);
      return Response.json({d:JSON.stringify(offset===60?[]:[{ShopID:1,EventID:1,HeldID:1,MemberID:100,
        Rank:'',HandleName:'fixture-zero',RankPoint:'0',JudgePoint:''}])});
    }});
  } finally {
    if(saved===undefined) delete process.env.ALLOW_DMP_FETCH; else process.env.ALLOW_DMP_FETCH=saved;
  }
  assert.deepEqual(offsets,[30,60]);
  assert.deepEqual(await q('SELECT placement,total_points FROM event_results ORDER BY dmp_id'),
    [{placement:1,total_points:50},{placement:null,total_points:0}]);
  assert.equal((await q("SELECT status FROM fetch_jobs"))[0].status,'done');
  assert.equal((await q("SELECT count(*)::int n FROM fetch_logs WHERE job_id=$1",[j.id]))[0].n,2);
});
