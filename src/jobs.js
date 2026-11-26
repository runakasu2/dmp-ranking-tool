import {acquisitionSettings,candidatePreview,candidates,eventPriority,externalTypes,measureDatabase,usage} from './acquisition.js';
import {comparisonName,hasNameCollision} from './handle-name.js';
import {randomUUID,createHash} from 'node:crypto';
import {transaction} from './db.js';
import {DmpClient, grades, scanEvent, wait} from './dmp.js';
import {compactHistory,recalculate,replayPendingPersonal,seasonLock,setting,setSetting,storeEvent,storeOfficial,storePersonal,storeSchedule,track,trackMany} from './ranking.js';

import {planCompletion,uncoveredDates} from './completion.js';
import {calculateVerification,collectVerificationEvents,verificationKey} from './verification.js';

const dayMs=86400000;
export const jst = (now=new Date()) => new Date(+now+9*3600000).toISOString();
const dayShift=(day,n)=>new Date(Date.parse(day)+n*dayMs).toISOString().slice(0,10);
export function slots(now, config={}) {
  const local=jst(now);
  const day=local.slice(0,10);
  const hour=Number(local.slice(11,13));
  const minute=Number(local.slice(14,16));
  const weekday=new Date(day).getUTCDay();
  const high=config.high?.[hour<12?0:hour<16?1:2] ?? (hour<12?60:hour<16?30:10);
  const wed=config.official?.[hour<12?0:hour<15?1:hour<18?2:3] ?? (hour<12?60:hour<15?30:hour<18?5:15);
  const bucket=interval=>local.slice(0,13)+':'+String(Math.floor(minute/interval)*interval).padStart(2,'0');
  return {day,high:bucket(high),official:weekday===3?bucket(wed):day,weekly:dayShift(day,-((weekday+6)%7)),
    next:new Date(now.getTime()+(Math.min(high-minute%high,weekday===3?wed-minute%wed:60))*60000-now.getUTCSeconds()*1000-now.getUTCMilliseconds())};
}
export async function enqueue(db,type,payload,key,priority,{reopen=false,reason=type,retry=false,successSince=null}={}) {
  if(type==='tracking'&&(await db.query(`SELECT 1 FROM fetch_jobs WHERE type='tracking'
    AND payload->>'season'=$1 AND status IN ('pending','running') LIMIT 1`,[String(payload.season)])).rows.length) return;
  if(type==='schedule') {
    const active=await db.query(`SELECT 1 FROM fetch_jobs WHERE type IN ('schedule','complete-schedule')
      AND (status IN ('pending','running') OR status='done' AND finished_at>=$6::timestamptz)
      AND payload->>'season'=$1 AND payload->>'grade'=$2
      AND payload->>'from'=$3 AND payload->>'to'=$4 AND coalesce(payload->>'upcoming','false')=$5 LIMIT 1`,
    [String(payload.season),payload.grade,payload.from,payload.to,String(Boolean(payload.upcoming)),successSince]);
    if(active.rows.length) return;
  }
  await db.query(`INSERT INTO fetch_jobs(type,payload,dedupe_key,priority,reason) VALUES($1,$2,$3,$4,$5)
    ON CONFLICT(dedupe_key) DO UPDATE SET
      priority=CASE WHEN fetch_jobs.status='pending' THEN least(fetch_jobs.priority,excluded.priority) ELSE excluded.priority END,
      reason=CASE WHEN fetch_jobs.status='pending' AND fetch_jobs.priority<excluded.priority THEN fetch_jobs.reason ELSE excluded.reason END,
      status='pending',next_run_at=CASE WHEN fetch_jobs.status='pending' AND fetch_jobs.priority<=excluded.priority
        THEN fetch_jobs.next_run_at ELSE now() END,
      attempts=CASE WHEN fetch_jobs.status='pending' THEN fetch_jobs.attempts ELSE 0 END,
      checkpoint=CASE WHEN fetch_jobs.status='pending' OR fetch_jobs.type='event' AND fetch_jobs.status='held'
        AND fetch_jobs.last_error LIKE 'Invalid integer event=%' THEN fetch_jobs.checkpoint END,last_error=NULL,started_at=NULL,finished_at=NULL
    WHERE NOT fetch_jobs.legacy_queue AND (
      fetch_jobs.status='pending' AND fetch_jobs.priority>excluded.priority OR
      $6 AND fetch_jobs.status IN ('done','held','cancelled') OR $7 AND fetch_jobs.status='failed')`,
    [type,payload,key,priority,reason,reopen,retry]);
}
export async function enqueueOfficial(db,season,key,{manual=false,successSince=null}={}) {
  const {rows:[active]}=await db.query(`SELECT id,status FROM fetch_jobs WHERE type='official' AND payload->>'season'=$1
    AND status IN ('pending','running','failed') ORDER BY (status='running') DESC,id LIMIT 1`,[String(season)]);
  if(active) {
    if(manual&&active.status!=='running') await db.query(`UPDATE fetch_jobs SET reason='administrator',
      next_run_at=now(),status='pending' WHERE id=$1 AND NOT legacy_queue AND status IN ('pending','failed')`,[active.id]);
    return;
  }
  if(!manual&&successSince&&(await db.query(`SELECT 1 FROM fetch_jobs WHERE type='official' AND payload->>'season'=$1
    AND status='done' AND finished_at>=$2::timestamptz LIMIT 1`,[String(season),successSince])).rows.length) return;
  await enqueue(db,'official',{season},key,0,{reopen:manual,reason:manual?'administrator':'official-clock'});
}

export async function enqueuePersonalBatch(db,season,ids,{reopen=false,priority=1,reason='official-top-coverage',retry=false,estimates={}}={}) {
  if(!ids.length) return;
  await db.query(`INSERT INTO fetch_jobs(type,payload,dedupe_key,priority,reason)
    SELECT 'personal',jsonb_build_object('season',$1::text,'id',id,'estimate',($7::jsonb->>id::text)::int),'personal:'||$1::text||':'||id,$3,$4
    FROM (SELECT DISTINCT unnest($2::int[]) id) x
    WHERE NOT EXISTS (SELECT 1 FROM fetch_jobs old WHERE old.type='personal'
      AND old.payload->>'season'=$1 AND old.payload->>'id'=id::text
      AND old.dedupe_key<>'personal:'||$1||':'||id AND old.status IN ('pending','failed','running'))
    ORDER BY id ON CONFLICT(dedupe_key) DO UPDATE SET status='pending',
      attempts=CASE WHEN fetch_jobs.status='pending' THEN fetch_jobs.attempts ELSE 0 END,next_run_at=now(),
      checkpoint=NULL,last_error=NULL,priority=excluded.priority,reason=excluded.reason,payload=excluded.payload,started_at=NULL,finished_at=NULL
    WHERE NOT fetch_jobs.legacy_queue AND (
      fetch_jobs.status='pending' AND fetch_jobs.priority>excluded.priority OR
      $5 AND fetch_jobs.status IN ('done','held','cancelled') OR $6 AND fetch_jobs.status='failed')`,
  [season,ids,priority,reason,reopen,retry,estimates]);
}
export function enqueueCompletion(db,seasonId) {
  return enqueue(db,'complete-personal',{season:seasonId},'complete-personal:'+seasonId,2,{reopen:true,reason:'missing-events'});
}
export async function claim(db,allowFetch=true,paused=false,{level=0,configuration={},now=null}={}) {
  const {backfillEnabled=true,backfillLimit=50,candidateLimit=50}=configuration;
  return (await db.query(`WITH local AS (
    SELECT coalesce($8::timestamptz,clock_timestamp()) AT TIME ZONE 'Asia/Tokyo' AS at
  ), picked AS (
    SELECT j.id FROM fetch_jobs j CROSS JOIN local
    WHERE NOT j.legacy_queue
      AND (j.type<>'tracking' OR NOT EXISTS(SELECT 1 FROM fetch_jobs t WHERE t.type='tracking' AND t.id<>j.id
        AND t.status='running' AND t.lease_until>clock_timestamp() AND t.payload->>'season'=j.payload->>'season'))
      AND ($2 AND $4<3 AND coalesce(
        (SELECT (value #>> '{}')::double precision FROM app_settings WHERE key='dmp_next_request'),0)
        <=extract(epoch FROM clock_timestamp())*1000 OR NOT (j.type=ANY($7)))
      AND (NOT $3 OR j.type IN ('maintenance','backup'))
      AND (j.priority<3 OR $4<2 OR NOT (j.type=ANY($7)))
      AND (j.priority<>4 OR NOT (j.type=ANY($7)) OR (
        $5 AND $4<1 AND local.at::time<time '12:00'
        AND NOT EXISTS (SELECT 1 FROM fetch_jobs h WHERE NOT h.legacy_queue AND h.priority<4 AND h.type=ANY($7)
          AND (h.status='running' OR h.status IN ('pending','failed') AND h.next_run_at<=clock_timestamp() AND (
            NOT (h.type='personal' AND h.priority=2 AND coalesce(h.reason,'') LIKE 'border-candidate%')
            OR EXISTS(SELECT 1 FROM candidate_daily_players c WHERE c.day=local.at::date AND c.dmp_id=(h.payload->>'id')::int)
            OR (SELECT count(*) FROM candidate_daily_players c WHERE c.day=local.at::date)<$9)))
        AND (j.type<>'event' OR EXISTS (SELECT 1 FROM backfill_daily_events b WHERE b.day=local.at::date
          AND b.event_id=(j.payload->>'id')::bigint)
          OR (SELECT count(*) FROM backfill_daily_events b WHERE b.day=local.at::date)<$6)))
      AND (NOT (j.type='personal' AND j.priority=2 AND coalesce(j.reason,'') LIKE 'border-candidate%')
        OR EXISTS(SELECT 1 FROM candidate_daily_players c WHERE c.day=local.at::date AND c.dmp_id=(j.payload->>'id')::int)
        OR (SELECT count(*) FROM candidate_daily_players c WHERE c.day=local.at::date)<$9)
      AND ((j.status IN ('pending','failed') AND j.next_run_at<=clock_timestamp())
      OR (j.status='running' AND j.lease_until<=clock_timestamp()))
    ORDER BY j.priority,
      CASE WHEN j.reason LIKE 'border-candidate%' THEN (j.payload->>'estimate')::int END DESC NULLS LAST,
      j.next_run_at,j.id LIMIT 1 FOR UPDATE OF j SKIP LOCKED
  ), taken AS (
    UPDATE fetch_jobs j SET status='running',lease_until=clock_timestamp()+interval '2 minutes',lease_token=$1,
      started_at=clock_timestamp(),finished_at=NULL FROM picked WHERE j.id=picked.id RETURNING j.*
  ), reserved AS (
    INSERT INTO backfill_daily_events(day,event_id,reservation_token)
    SELECT local.at::date,(taken.payload->>'id')::bigint,taken.lease_token FROM taken CROSS JOIN local WHERE taken.type='event' AND taken.priority=4
    ON CONFLICT(day,event_id) DO UPDATE SET reservation_token=NULL
    WHERE backfill_daily_events.reservation_token IS NOT NULL
      AND backfill_daily_events.reservation_token<>excluded.reservation_token
  ), reserved_candidate AS (
    INSERT INTO candidate_daily_players(day,dmp_id,reservation_token)
    SELECT local.at::date,(taken.payload->>'id')::int,taken.lease_token FROM taken CROSS JOIN local
    WHERE taken.type='personal' AND taken.priority=2 AND taken.reason LIKE 'border-candidate%'
    ON CONFLICT(day,dmp_id) DO UPDATE SET reservation_token=NULL
    WHERE candidate_daily_players.reservation_token IS NOT NULL
      AND candidate_daily_players.reservation_token<>excluded.reservation_token
  ) SELECT * FROM taken`,[randomUUID(),allowFetch,paused,level,backfillEnabled,backfillLimit,externalTypes,now,candidateLimit])).rows[0];
}
export async function claimAcquisition(pool,allowFetch,now=null) {
  return transaction(pool,async db=>{
    await db.query('SELECT pg_advisory_xact_lock(440004)');
    const {rows:[slots]}=await db.query(`SELECT count(*)::int n FROM fetch_jobs
      WHERE status='running' AND lease_until>clock_timestamp()`);
    if(slots.n>=2) return;
    const limits=await usage(db);
    return claim(db,allowFetch,await setting(db,'paused',false),{...limits,now});
  });
}
async function fence(db,job) {
  if (!(await db.query(`SELECT 1 FROM fetch_jobs WHERE id=$1 AND lease_token=$2 AND status='running' AND lease_until>clock_timestamp() FOR NO KEY UPDATE`,
    [job.id,job.lease_token])).rows.length) throw new Error('Lease expired');
}
export async function renewLease(db,job,{waitForRow=false}={}) {
  const {rows}=await db.query(`WITH owned AS (
    SELECT id FROM fetch_jobs WHERE id=$1 AND lease_token=$2 AND status='running'
      AND lease_until>clock_timestamp() FOR NO KEY UPDATE ${waitForRow?'':'SKIP LOCKED'}
  )
  UPDATE fetch_jobs j SET lease_until=clock_timestamp()+interval '2 minutes'
  FROM owned WHERE j.id=owned.id RETURNING j.id`,[job.id,job.lease_token]);
  return rows.length>0;
}
async function recordPhase(db,job,phase) {
  await db.query(`INSERT INTO fetch_job_progress(job_id,lease_token,phase)
    SELECT id,lease_token,$3 FROM fetch_jobs WHERE id=$1 AND lease_token=$2 AND status='running'
    ON CONFLICT(job_id) DO UPDATE SET lease_token=excluded.lease_token,phase=excluded.phase,phase_started_at=excluded.phase_started_at`,
  [job.id,job.lease_token,phase]);
}
function deferDispatch(message,retryAt=Date.now()+60000) {
  return Object.assign(new Error(message),{deferred:true,retryAt});
}
const candidateJob=job=>job.type==='personal'&&job.priority===2&&job.reason?.startsWith('border-candidate');
async function releaseUnusedSlots(db,job) {
  if(candidateJob(job)) await db.query('DELETE FROM candidate_daily_players WHERE dmp_id=$1 AND reservation_token=$2',
    [job.payload.id,job.lease_token]);
  if(job.type==='event'&&job.priority===4) await db.query(
    'DELETE FROM backfill_daily_events WHERE event_id=$1 AND reservation_token=$2',[job.payload.id,job.lease_token]);
}

async function normalAcquisitionReady(db,candidateLimit) {
  const {rows:[ready]}=await db.query(`SELECT EXISTS(SELECT 1 FROM fetch_jobs
    WHERE NOT legacy_queue AND priority<4 AND type=ANY($1) AND status IN ('pending','failed')
      AND next_run_at<=clock_timestamp()
      AND (NOT (type='personal' AND priority=2 AND coalesce(reason,'') LIKE 'border-candidate%')
        OR EXISTS(SELECT 1 FROM candidate_daily_players c WHERE c.day=(now() AT TIME ZONE 'Asia/Tokyo')::date
          AND c.dmp_id=(fetch_jobs.payload->>'id')::int)
        OR (SELECT count(*) FROM candidate_daily_players c WHERE c.day=(now() AT TIME ZONE 'Asia/Tokyo')::date)<$2)) AS found`,
  [externalTypes,candidateLimit]);
  return ready.found;
}
export async function dispatchDmpRequest(pool,job,start,{first=true,now=()=>new Date()}={}) {
  // The transaction lock works with transaction-pooled connections. Waiting a
  // full interval after acquiring it also covers an uncommitted prior dispatch
  // whose worker exited before releasing the lock.
  let response;
  let connectionError;
  const controller=new AbortController();
  const onConnectionError=error=>{
    connectionError=error;
    controller.abort(error);
  };
  const db=await pool.connect();
  try {
    db.on?.('error',onConnectionError);
    await db.query('BEGIN');
    await db.query('SELECT pg_advisory_xact_lock(440005)');
    const earliest=performance.now()+1000;
    while(performance.now()<earliest) await wait(Math.ceil(earliest-performance.now()));
    if(!await renewLease(db,job,{waitForRow:true})) throw new Error('Lease expired');
    // Keep the cooldown writer independent of the one-second wait.
    await db.query('SELECT pg_advisory_xact_lock(440002)');
    const retryAt=await setting(db,'dmp_next_request',0);
    if(retryAt>Date.now()) throw deferDispatch('DMP cooldown',retryAt);
    const {level,configuration}=await usage(db);
    if(await setting(db,'paused',false) || level>=3 || level>=2&&job.priority===3 || level>=1&&job.priority===4 ||
      job.priority===4&&!configuration.backfillEnabled) {
      throw deferDispatch('Acquisition restricted');
    }
    await fence(db,job);
    if(job.type==='event'&&job.priority===4) {
      // Rollback leaves the already durable reservation in place if dispatch
      // or commit becomes ambiguous. Only a proven no-send can release it.
      await db.query('UPDATE backfill_daily_events SET reservation_token=NULL WHERE event_id=$1 AND reservation_token=$2',
        [job.payload.id,job.lease_token]);
    }
    if(candidateJob(job)&&first) {
      const [decision]=await candidates(db,job.payload.season,[Number(job.payload.id)]);
      if(!decision?.decision.startsWith('qualify-')) {
        throw Object.assign(deferDispatch('Candidate requires reevaluation'),{hold:true});
      }
      await db.query('UPDATE candidate_daily_players SET reservation_token=NULL WHERE dmp_id=$1 AND reservation_token=$2',
        [job.payload.id,job.lease_token]);
    }
    if(job.priority===4&&await normalAcquisitionReady(db,configuration.candidateLimit)) {
      throw deferDispatch('Backfill yields to normal work',Date.now()+1000);
    }
    if(job.priority===4&&first&&Number(jst(now()).slice(11,13))>=12) {
      const local=jst(now()).slice(0,10);
      throw deferDispatch('Backfill window closed',Date.parse(dayShift(local,1)+'T00:00:00+09:00'));
    }
    if(connectionError) throw connectionError;
    // No asynchronous work follows the final time-window check.
    // Do not await the HTTP promise while holding the transaction lock.
    response=Promise.resolve(start(controller.signal));
    response.catch(()=>{});
    await db.query('COMMIT');
  } catch(error) {
    controller.abort(error);
    await db.query('ROLLBACK').catch(()=>{});
    throw error;
  } finally {
    db.removeListener?.('error',onConnectionError);
    db.release(connectionError);
  }
  return response;
}

async function extendDmpCooldown(db,retryAt) {
  await db.query('SELECT pg_advisory_xact_lock(440002)');
  const current=await setting(db,'dmp_next_request',0);
  if(retryAt>current) await setSetting(db,'dmp_next_request',retryAt);
}

export async function reevaluateEventPlayers(db,season,ids) {
  if(!ids.length) return;
  const {rows:[running]}=await db.query(`SELECT 1 FROM fetch_jobs WHERE type='tracking' AND status='running'
    AND payload->>'season'=$1 LIMIT 1`,[String(season.id)]);
  if(running) {
    const key='tracking-dirty:'+season.id;
    const pending=await setting(db,key,[]);
    await setSetting(db,key,[...new Set([...pending,...ids])]);
    return;
  }
  await planTracking(db,season,{evaluateCandidates:true,playerIds:ids});
}

export async function enqueueCandidatePreview(db,season,ids=null,evaluated=null) {
  const [snapshot,limits]=await Promise.all([candidatePreview(db,season,ids,evaluated),usage(db)]);
  if(await setting(db,'paused',false)||limits.level>=3) return {registered:0,paused:true};
  const qualified=snapshot.rows.filter(row=>row.decision.startsWith('qualify-'));
  if(!evaluated&&qualified.length) await db.query(`INSERT INTO tracking_candidate_decisions(season_id,dmp_id,details)
    SELECT $1,(item->>'dmp_id')::int,item FROM jsonb_array_elements($2::jsonb) x(item)
    ON CONFLICT(season_id,dmp_id) DO UPDATE SET details=excluded.details,evaluated_at=now()`,[season,JSON.stringify(qualified)]);
  await trackMany(db,season,snapshot.selected.map(row=>row.dmp_id),'candidate');
  await enqueuePersonalBatch(db,season,snapshot.selected.map(row=>row.dmp_id),{
    reopen:true,priority:2,reason:'border-candidate',
    estimates:Object.fromEntries(snapshot.selected.map(row=>[row.dmp_id,row.upper]))
  });
  return {registered:snapshot.selected.length};
}

async function planTracking(db,season,{evaluateCandidates=false,playerIds=null}={}) {
  await db.query(`UPDATE tracked_players SET reasons=array_remove(reasons,'watch'),active=cardinality(array_remove(reasons,'watch'))>0
    WHERE season_id=$1 AND 'watch'=ANY(reasons) AND last_requested_at<now()-interval '30 days'`,[season.id]);
  if(evaluateCandidates) {
    const decisions=await candidates(db,season.id,playerIds);
    await enqueueCandidatePreview(db,season.id,playerIds,decisions);
    if(decisions.length) {
      const evidence=decisions.filter(row=>row.evidence_count>0||row.decision.startsWith('qualify-'));
      if(evidence.length) await db.query(`INSERT INTO tracking_candidate_decisions(season_id,dmp_id,details)
        SELECT $1,(item->>'dmp_id')::int,item FROM jsonb_array_elements($2::jsonb) x(item)
        ON CONFLICT(season_id,dmp_id) DO UPDATE SET details=excluded.details,evaluated_at=now()
        WHERE tracking_candidate_decisions.details IS DISTINCT FROM excluded.details`,[season.id,JSON.stringify(evidence)]);
      await db.query(`UPDATE fetch_jobs j SET reason=(CASE WHEN j.status='pending' AND x.decision LIKE 'qualify-%' THEN 'border-candidate ' ELSE '' END)||x.decision||' '||jsonb_build_object(
          'rank',x.rank,'official',x.official_points,'upper',x.upper,'border',x.border,'known',x.known,'evidence',x.evidence_count)::text,
        status=CASE WHEN x.decision='below-border' THEN 'cancelled'
          WHEN j.status='pending' AND x.decision NOT LIKE 'qualify-%' THEN 'held' ELSE j.status END,
        payload=jsonb_set(j.payload,'{estimate}',to_jsonb(coalesce(x.upper,0)),true)
        FROM jsonb_to_recordset($2::jsonb) x(dmp_id int,decision text,rank int,official_points int,upper int,border int,known int,evidence_count int)
        WHERE j.type='personal' AND j.payload->>'season'=$1::text AND j.payload->>'id'=x.dmp_id::text
          AND NOT j.legacy_queue AND (j.status='held' OR j.status='pending' AND j.reason LIKE 'border-candidate%')`,
      [season.id,JSON.stringify(decisions)]);
    }
  }
  const {rows:ranked}=await db.query('SELECT dmp_id FROM provisional_rankings WHERE season_id=$1 AND rank<=200',[season.id]);
  const top=ranked.map(row=>row.dmp_id);
  await db.query(`UPDATE tracked_players SET reasons=array_remove(reasons,'provisional'),active=cardinality(array_remove(reasons,'provisional'))>0
    WHERE season_id=$1 AND 'provisional'=ANY(reasons) AND NOT(dmp_id=ANY($2::int[]))`,[season.id,top]);
  await trackMany(db,season.id,top,'provisional');
  const {rows:pending}=await db.query(`SELECT dmp_id FROM tracked_players t WHERE season_id=$1 AND active AND backfill_status='pending'
    AND reasons && ARRAY['watch','admin','previous']
    AND NOT EXISTS (SELECT 1 FROM personal_fetch_coverage c WHERE c.season_id=t.season_id AND c.dmp_id=t.dmp_id)`,[season.id]);
  await enqueuePersonalBatch(db,season.id,pending.map(row=>row.dmp_id),{reopen:true,priority:2,reason:'tracked-coverage'});
}

async function planEventJobs(db,season,day,grade=null,from=null,to=null) {
  const {rows}=await db.query(`SELECT id,last_fetched_at,urgent_fetch,registration_transition_at,event_date::text
    FROM events WHERE season_id=$1 AND multiplier IS NOT NULL AND official_reflected_at IS NULL AND next_fetch_at<=now()
    AND (urgent_fetch OR last_fetched_at IS NULL OR coalesce(first_fetched_at,last_fetched_at)>now()-interval '31 days')
    AND event_date<=$2::date AND ($3::text IS NULL OR grade=$3) AND ($4::date IS NULL OR event_date BETWEEN $4 AND $5)
    ORDER BY id`,[season,day,grade,from,to]);
  const planned=rows.map(row=>{
    return {id:row.id,...eventPriority(row,day)};
  });
  if(!planned.length) return;
  await db.query(`INSERT INTO fetch_jobs(type,payload,dedupe_key,priority,reason)
    SELECT 'event',jsonb_build_object('season',$1::text,'id',x.id::text),'event:'||x.id,x.priority,x.reason
    FROM jsonb_to_recordset($2::jsonb) x(id bigint,priority integer,reason text) ORDER BY x.id
    ON CONFLICT(dedupe_key) DO UPDATE SET priority=excluded.priority,reason=excluded.reason,status='pending',
      next_run_at=now(),attempts=CASE WHEN fetch_jobs.status='pending' THEN fetch_jobs.attempts ELSE 0 END,
      checkpoint=CASE WHEN fetch_jobs.status='pending' THEN fetch_jobs.checkpoint END,
      last_error=NULL,started_at=NULL,finished_at=NULL
    WHERE NOT fetch_jobs.legacy_queue AND (
      fetch_jobs.status IN ('done','cancelled') OR fetch_jobs.status='pending' AND (
        fetch_jobs.priority>excluded.priority AND (fetch_jobs.priority<>4 OR excluded.reason='event-change')
       ))`,
  [season,JSON.stringify(planned)]);
}

async function planWeeklyPersonal(db,season,now) {
  const {personalDays}=await acquisitionSettings(db);
  const local=jst(now);
  const hour=Number(local.slice(11,13));
  if(hour>=12||!season.initialized_at) return;
  const bucket=Math.floor(Date.parse(local.slice(0,10))/dayMs)*12+hour;
  const {rows}=await db.query(`SELECT t.dmp_id FROM tracked_players t LEFT JOIN personal_fetch_coverage c USING(season_id,dmp_id)
    WHERE t.season_id=$1 AND t.active AND t.backfill_status IN ('ready','stale')
      AND mod(t.dmp_id,$4::int*12)=mod($2::int,$4::int*12)
      AND (c.succeeded_at IS NULL OR date_trunc('hour',c.succeeded_at) <= date_trunc('hour',$3::timestamptz)-$4::int*interval '1 day'
        OR c.starts_on>$5::date OR c.through_on<least($6::date,$7::date-$4::int))
      AND NOT EXISTS (SELECT 1 FROM fetch_jobs j WHERE j.dedupe_key='personal:'||$1::text||':'||t.dmp_id
         AND j.status='done' AND j.reason='personal-weekly' AND j.finished_at >= $3::timestamptz-interval '1 hour')
    ORDER BY t.dmp_id`,[season.id,bucket,now,personalDays,season.starts_on,season.ends_on,local.slice(0,10)]);
  await enqueuePersonalBatch(db,season.id,rows.map(row=>row.dmp_id),{reopen:true,priority:3,reason:'personal-weekly'});
  const key='weekly-catchup:'+season.id+':'+local.slice(0,13);
  if(await setting(db,'weekly-catchup:'+season.id)===key) return;
  const {rows:overdue}=await db.query(`SELECT t.dmp_id FROM tracked_players t
    LEFT JOIN personal_fetch_coverage c USING(season_id,dmp_id)
    WHERE t.season_id=$1 AND t.active AND t.backfill_status IN ('ready','stale')
      AND coalesce(c.succeeded_at,$2::timestamptz)<$3::timestamptz-$4::int*interval '1 day'
      AND NOT EXISTS(SELECT 1 FROM fetch_jobs j WHERE j.type='personal'
        AND j.payload->>'season'=$1::bigint::text AND j.payload->>'id'=t.dmp_id::text
        AND j.status IN ('pending','running','failed'))
    ORDER BY c.succeeded_at NULLS FIRST,t.dmp_id LIMIT 5`,[season.id,season.initialized_at,now,personalDays]);
  await enqueuePersonalBatch(db,season.id,overdue.map(row=>row.dmp_id),{reopen:true,priority:3,reason:'personal-weekly'});
  await setSetting(db,'weekly-catchup:'+season.id,key);

}

export async function schedule(db,now=new Date()) {
  await db.query('SELECT pg_advisory_xact_lock(440004)');
  const config=await setting(db,'schedule',{});
  const slot=slots(now,config);
  if(await setting(db,'paused',false)) {
    await enqueue(db,'maintenance',{},'maintenance:'+slot.day,0);
    return slot.next;
  }
  const {rows:seasons}=await db.query(`SELECT id,starts_on::text,ends_on::text,initialized_at FROM seasons
    WHERE $1::date BETWEEN starts_on AND ends_on AND finalized_at IS NULL`,[slot.day]);
  for(const season of seasons) {
    const sid=season.id;
    await seasonLock(db,sid);
    const payload={season:sid};
    const startOf=key=>new Date((key.includes('T')?key:key+'T00:00')+':00+09:00');
    await enqueueOfficial(db,sid,'official:'+sid+':'+slot.official,{successSince:startOf(slot.official)});
    const windows=[['CS',7,0,slot.high],['CS',14,8,slot.day],['CS',30,15,slot.weekly]];
    for(const grade of grades.slice(1)) windows.push([grade,30,0,slot.day]);
    for(const [grade,older,newer,key] of windows) {
      const from=[dayShift(slot.day,-older),season.starts_on].sort().at(-1);
      const to=[dayShift(slot.day,-newer),season.ends_on].sort()[0];
      if(from<=to) await enqueue(db,'schedule',{...payload,grade,from,to},['schedule',sid,grade,older,key].join(':'),2,{successSince:startOf(key)});
    }
    const scheduleSettings=await setting(db,'source_mapping',{});
    if(scheduleSettings.upcomingMode!==false) {
      for(const grade of grades) {
        await enqueue(db,'schedule',{...payload,grade,from:slot.day,to:[dayShift(slot.day,30),season.ends_on].sort()[0],upcoming:true},['upcoming',sid,grade,slot.day].join(':'),3,{successSince:startOf(slot.day)});
      }
    }
    const {rows:large}=await db.query(`SELECT id,grade,event_date::text FROM events WHERE season_id=$1 AND event_date<=$2
      AND event_date >= $2::date-30 AND grade<>'CS' AND multiplier IS NULL`,[sid,slot.day]);
    for(const event of large) await enqueue(db,'schedule',{...payload,grade:event.grade,from:event.event_date,to:event.event_date},
      ['large',sid,event.id,slot.high].join(':'),2,{successSince:startOf(slot.high)});
    await planEventJobs(db,sid,slot.day);
    await planWeeklyPersonal(db,season,now);
    const historyEnd=[dayShift(slot.day,-31),season.ends_on].sort()[0];
    if(historyEnd>=season.starts_on) {
      const {rows:[next]}=await db.query(`SELECT count(*)::int completed FROM fetch_jobs
        WHERE type='schedule' AND dedupe_key LIKE $1 AND status='done'`,['backfill-list:'+sid+':%']);
      const from=dayShift(season.starts_on,Math.floor(next.completed/grades.length)*7);
      const grade=grades[next.completed%grades.length];
      const to=dayShift(from,6);
      if(to<=historyEnd) await enqueue(db,'schedule',{...payload,grade,from,to},['backfill-list',sid,grade,from].join(':'),4,
        {reason:'historical-discovery'});
    }
    await enqueue(db,'tracking',payload,'tracking:'+sid+':'+slot.high,2);
  }
  await enqueue(db,'maintenance',{},'maintenance:'+slot.day,0);
  return slot.next;
}
export async function reconcile(db,season,time,player=null,{queueMismatch=true}={}) {
  const {rows:[rule]}=await db.query('SELECT version,weekly_limit,grade_rules,effective_at FROM aggregation_rules WHERE season_id=$1 ORDER BY version DESC LIMIT 1',[season.id]);
  if(!rule) return;
  const ruleChanged=rule.version>1&&new Date(rule.effective_at)>new Date(time);
  const mismatches=await db.query(`WITH officials AS (
    SELECT o.dmp_id,o.points,t.backfill_status FROM official_rankings o
    LEFT JOIN tracked_players t USING(season_id,dmp_id) WHERE o.season_id=$1 AND o.rank<=200 AND ($5::int[] IS NULL OR o.dmp_id=ANY($5))
  ), inputs AS (
    SELECT r.dmp_id,r.total_points,r.active,e.event_date,e.event_year,e.shop_id,e.source_event_id,e.held_id,
      $3::jsonb->>e.grade mode,
      (r.total_points>0 AND ((e.event_date=($2::timestamptz AT TIME ZONE 'Asia/Tokyo')::date
        AND r.source_updated_at IS NULL AND r.updated_at>$2)
        OR r.source_updated_at>$2 OR EXISTS(
          SELECT 1 FROM event_result_changes c WHERE c.event_result_id=r.id AND c.detected_at>$2
          AND ((c.changed_fields ? 'total_points' AND (c.changed_fields->'total_points'->>'before') IS NOT NULL)
            OR (c.changed_fields->'active'->>'before')='true')
        ))) unclear
    FROM event_results r JOIN events e ON e.id=r.event_id JOIN officials o ON o.dmp_id=r.dmp_id
    WHERE e.season_id=$1 AND e.event_date<=($2::timestamptz AT TIME ZONE 'Asia/Tokyo')::date
  ), ranked AS (
    SELECT *,row_number() OVER(PARTITION BY dmp_id,date_trunc('week',event_date::timestamp),mode,active
      ORDER BY total_points DESC,event_year,shop_id,source_event_id,held_id) sequence FROM inputs
  ), totals AS (
    SELECT dmp_id,bool_or(unclear) unclear,coalesce(sum(total_points) FILTER(WHERE active AND (mode='extra'
      OR (mode='weekly' AND sequence<=$4))),0)::int computed FROM ranked GROUP BY dmp_id
  )
  , compared AS (
    SELECT o.dmp_id,o.points official,o.backfill_status,coalesce(t.unclear,false) unclear,coalesce(t.computed,0) computed,
      coalesce(o.backfill_status='ready' AND NOT coalesce(t.unclear,false) AND NOT $6::boolean,false) comparable
    FROM officials o LEFT JOIN totals t USING(dmp_id)
  ), verdict AS (
    SELECT *,CASE WHEN NOT comparable THEN 'unknown' WHEN official=computed THEN 'match' ELSE 'mismatch' END status
    FROM compared
  ), first_mismatch AS MATERIALIZED (
    SELECT v.dmp_id FROM verdict v WHERE v.status='mismatch' AND NOT EXISTS (
      SELECT 1 FROM sync_discrepancies d WHERE d.season_id=$1 AND d.dmp_id=v.dmp_id
        AND d.aggregation_at=$2 AND d.status='mismatch'
    )
  ), saved AS (
    INSERT INTO sync_discrepancies(season_id,dmp_id,aggregation_at,official_points,computed_points,status,details)
    SELECT $1,dmp_id,$2,official,CASE WHEN comparable THEN computed END,status,
      jsonb_build_object('unclear',unclear,'ruleChanged',$6::boolean,'coverage',backfill_status) FROM verdict
    ON CONFLICT(season_id,dmp_id,aggregation_at) DO UPDATE SET computed_points=excluded.computed_points,status=excluded.status,details=excluded.details
    WHERE (sync_discrepancies.computed_points,sync_discrepancies.status,sync_discrepancies.details) IS DISTINCT FROM
      (excluded.computed_points,excluded.status,excluded.details)
  )
  SELECT dmp_id FROM first_mismatch`,
  [season.id,time,rule.grade_rules,rule.weekly_limit,player===null?null:[player].flat(),ruleChanged]);
  if(queueMismatch) await enqueuePersonalBatch(db,season.id,mismatches.rows.map(row=>row.dmp_id),{reopen:true,priority:2,reason:'official-mismatch'});
  // Keep automatic confirmation disabled until the source flag is validated.
  await db.query(`UPDATE events e SET official_reflected_at=NULL,next_fetch_at=now() WHERE e.season_id=$1
    AND e.official_reflected_at IS NOT NULL AND EXISTS(
      SELECT 1 FROM event_results r JOIN sync_discrepancies d ON d.season_id=e.season_id
        AND d.dmp_id=r.dmp_id AND d.aggregation_at=$2 AND d.status='mismatch' WHERE r.event_id=e.id AND r.active)`,[season.id,time]);
}
async function applyPersonalReplay(db,season,changed,stage) {
  await stage('personal_replay');
  const replayed=await replayPendingPersonal(db,season.id);
  if(replayed.length) {
    await stage('official_reconcile');
    const {rows:[latest]}=await db.query('SELECT max(aggregation_at) AS time FROM official_rankings WHERE season_id=$1',[season.id]);
    if(latest.time) await reconcile(db,season,latest.time,replayed);
  }
  const affected=[...new Set([...changed,...replayed])];
  if(affected.length) {
    await stage('recalculate');
    await recalculate(db,season.id,affected);
  }
}

async function verifyPersonalNameUniqueness(db,player) {
  const expected=comparisonName(player.handle_name.trim());
  if(expected===null||await hasNameCollision(db,player.dmp_id,expected)) {
    throw new Error('Unexpected personal history identity: dmp='+player.dmp_id+' invalid or ambiguous name');
  }
}

function asEvent(row) {
  return {...row,eventDate:row.event_date,shopId:row.shop_id,eventId:row.source_event_id,heldId:row.held_id};
}
export async function runJob(pool,job,{client,backup,fetcher,now}={}) {
  let bytes=0;
  let receivedBytes=null;
  let records=0;
  let completionFetched=false;
  const started=Date.now();
  const phaseMs={};
  let currentPhase;
  let phaseStarted=performance.now();
  let heartbeat;
  let renewing=false;
  function accumulatePhase() {
    const now=performance.now();
    if(currentPhase) phaseMs[currentPhase]=(phaseMs[currentPhase]??0)+Math.round(now-phaseStarted);
    phaseStarted=now;
  }
  const stage=async phase=>{
    accumulatePhase();
    currentPhase=phase;
    await recordPhase(pool,job,phase).catch(()=>console.error('Job phase update failed',job.id));
  };
  const apply=work=>transaction(pool,async db=>{
    if(job.payload.season) await seasonLock(db,job.payload.season);
    await fence(db,job);
    return work(db);
  });
  let hasDispatched=Boolean(client);
  client ??= new DmpClient({enabled:process.env.ALLOW_DMP_FETCH==='true',fetcher,
    dispatch:start=>dispatchDmpRequest(pool,job,signal=>{
      hasDispatched=true;
      return start(signal);
    },{first:!hasDispatched,now}),
    recordRetryAt:retryAt=>transaction(pool,db=>extendDmpCooldown(db,retryAt)),meter:n=>{bytes+=n;},recordTraffic:(n,status)=>{
    receivedBytes=(receivedBytes??0)+n;
    return transaction(pool,async db=>{
      await db.query('SELECT pg_advisory_xact_lock(440002)');
      await db.query(`INSERT INTO dmp_traffic_daily(day,bytes,measured_at)
        VALUES((now() AT TIME ZONE 'Asia/Tokyo')::date,$1,clock_timestamp())
        ON CONFLICT(day) DO UPDATE SET bytes=dmp_traffic_daily.bytes+excluded.bytes,measured_at=excluded.measured_at`,[n]);
      const errors=await setting(db,'dmp_consecutive_errors',0);
      if(status>=500) {
        await setSetting(db,'dmp_consecutive_errors',errors+1);
        if(errors>=2) await setSetting(db,'dmp_next_request',Math.max(Date.now()+60000,await setting(db,'dmp_next_request',0)));
      } else if(errors&&status>=200&&status<400) {
        await setSetting(db,'dmp_consecutive_errors',0);
      }
    });
  }});
  const finish=async(db,status,error=null,next=null,{unused=false}={})=>{
    if(status==='done'||!hasDispatched||unused) await releaseUnusedSlots(db,job);
    accumulatePhase();
    await db.query(`WITH finished AS (
      UPDATE fetch_jobs SET status=$2,attempts=CASE WHEN $2='done' THEN 0 WHEN $3::text IS NULL THEN attempts ELSE attempts+1 END,
        last_error=$3,next_run_at=coalesce($4,next_run_at),lease_until=NULL,lease_token=NULL,finished_at=clock_timestamp(),
        checkpoint=CASE WHEN $2='done' THEN NULL ELSE checkpoint END
      WHERE id=$1 RETURNING id,started_at,finished_at
    )
    INSERT INTO fetch_logs(job_id,status,bytes,duration,records,error,created_at,started_at,finished_at,phase_ms,received_bytes)
    SELECT id,$2,$5,$6,$7,$3,finished_at,started_at,finished_at,$8,$9 FROM finished`,
    [job.id,status,error,next,bytes,Date.now()-started,records,phaseMs,receivedBytes]);
  };
  try {
    if(!await renewLease(pool,job,{waitForRow:true})) return releaseUnusedSlots(pool,job);
    heartbeat=setInterval(async()=>{
      if(renewing) return;
      renewing=true;
      try {await renewLease(pool,job);}
      catch {console.error('Job lease renewal failed',job.id);}
      finally {renewing=false;}
    },20000).unref();
    await stage('prepare');
    const p=job.payload;
    const season=p.season&&(await pool.query('SELECT *,starts_on::text,ends_on::text FROM seasons WHERE id=$1',[p.season])).rows[0];
    const map=await setting(pool,'source_mapping',{});
    if(season?.compacted_at) return await apply(db=>finish(db,'done'));
    let work=async()=>{};
    if(job.type==='official'||job.type==='official-only') {
      const {rows:[old]}=await pool.query('SELECT max(aggregation_at) AS time FROM official_rankings WHERE season_id=$1',[season.id]);
      await stage('official_fetch');
      const previous=old.time&&new Date(old.time).toISOString();
      const pendingDiff=job.reason==='administrator'&&job.type==='official'&&await setting(pool,'official-diff-pending:'+season.id);
      const snapshot=await client.official(season,job.type==='official-only'?null:previous,map.official)
        ?? (pendingDiff&&pendingDiff===previous?{time:previous,rows:[]}:null);
      if(snapshot) {
        records=snapshot.rows.length;
        work=async db=>{
          await stage('official_store');
          await db.query(`INSERT INTO official_update_baselines(season_id,aggregation_at,rows)
            SELECT $1,$2,coalesce(jsonb_agg(jsonb_build_object('dmp_id',coalesce(r.dmp_id,o.dmp_id),'rank',r.rank,'points',r.points,
              'status',r.status,'officialRank',o.rank,'officialPoints',o.points) ORDER BY r.rank,r.dmp_id),'[]'::jsonb)
            FROM provisional_rankings r FULL JOIN official_rankings o USING(season_id,dmp_id)
            WHERE coalesce(r.season_id,o.season_id)=$1 AND (r.rank<=200 OR o.rank<=200) ON CONFLICT DO NOTHING`,[season.id,snapshot.time]);
          const stored=snapshot.rows.length>0&&await storeOfficial(db,season,snapshot);
          if(job.type==='official-only') {
            if(stored) await setSetting(db,'official-diff-pending:'+season.id,snapshot.time);
            return;
          }
          const pendingDiff=await setting(db,'official-diff-pending:'+season.id);
          if(!stored&&pendingDiff!==snapshot.time) return;
          await db.query('DELETE FROM app_settings WHERE key=$1',['official-diff-pending:'+season.id]);
          const {rows:needed}=await db.query(`SELECT o.dmp_id FROM official_rankings o
            LEFT JOIN tracked_players t USING(season_id,dmp_id) LEFT JOIN personal_fetch_coverage c USING(season_id,dmp_id)
            WHERE o.season_id=$1 AND o.rank<=200
              AND (t.backfill_status IS DISTINCT FROM 'ready' OR c.starts_on>$2::date
                OR c.through_on<least($4::date,($5::timestamptz AT TIME ZONE 'Asia/Tokyo')::date)
                  AND NOT EXISTS(SELECT 1 FROM official_history h WHERE h.season_id=o.season_id AND h.dmp_id=o.dmp_id
                    AND h.aggregation_at=(SELECT max(prior.aggregation_at) FROM official_history prior
                      WHERE prior.season_id=o.season_id AND prior.aggregation_at<$3) AND h.rank<=200))
              AND NOT EXISTS(SELECT 1 FROM pending_personal_results p WHERE p.season_id=o.season_id AND p.dmp_id=o.dmp_id AND (p.data->>'totalPoints')::int>0)
            `,[season.id,season.starts_on,snapshot.time,season.ends_on,snapshot.time]);
          await enqueuePersonalBatch(db,season.id,needed.map(row=>row.dmp_id),{reopen:true});
          if((await uncoveredDates(db,season.id)).length) await enqueueCompletion(db,season.id);
          await stage('official_reconcile');
          await reconcile(db,season,snapshot.time);
          await stage('recalculate');
          await recalculate(db,season.id,[]);
          await planTracking(db,season);
        };
      }
    } else if(job.type==='complete-personal') {
      work=async db=>{
        await applyPersonalReplay(db,season,[],stage);
        await stage('plan_completion');
        await planCompletion(db,season);
      };
    } else if(job.type==='complete-schedule'||job.type==='schedule') {
      const completion=job.type==='complete-schedule';
      const needed=completion?await uncoveredDates(pool,season.id,p.from,p.to):null;
      let rows=[];
      if(!needed||needed.length) {
        await stage('schedule_fetch');
        rows=await client.schedule(p.grade,p.from,p.to,p.upcoming?(map.upcomingMode??''):'Result',map.schedule);
      }
      completionFetched=completion&&needed.length>0;
      if(rows.some(r=>r.eventDate<p.from||r.eventDate>p.to)) throw new Error('Schedule response outside requested window');
      records=rows.length;
      work=async db=>{
        await stage('schedule_store');
        const changed=await storeSchedule(db,season,rows);
        if(!p.upcoming) await applyPersonalReplay(db,season,changed,stage);
        else if(changed.length) {
          await stage('recalculate');
          await recalculate(db,season.id,changed);
        }
        if(completion) return;
        if(!p.upcoming) await planEventJobs(db,season.id,jst().slice(0,10),p.grade,p.from,p.to);
      };
    } else if(job.type==='event') {
      const row=(await pool.query('SELECT *,event_date::text FROM events WHERE id=$1 AND season_id=$2',[p.id,p.season])).rows[0];
      if(!row || row.multiplier===null) return await apply(db=>finish(db,'done'));
      const event=asEvent(row);
      const signature=JSON.stringify([event.eventDate,event.multiplier]);
      const checkpoint=job.checkpoint?.signature===signature ? job.checkpoint : {signature,offset:0};
      if(checkpoint!==job.checkpoint) await apply(async db=>{
        await db.query('DELETE FROM job_event_pages WHERE job_id=$1',[job.id]);
        await db.query('UPDATE fetch_jobs SET checkpoint=$2 WHERE id=$1',[job.id,checkpoint]);
      });
      await stage('event_fetch');
      const scan=await scanEvent(client,event,{offset:checkpoint.offset,pages:20,mapping:map.event,save:async(offset,rows,next)=>{
        const hash=createHash('sha256').update(JSON.stringify(rows)).digest('hex');
        await apply(async db=>{
          const duplicate=await db.query('SELECT 1 FROM job_event_pages WHERE job_id=$1 AND page_hash=$2',[job.id,hash]);
          if(duplicate.rows.length) throw new Error('Repeated event page');
          await db.query('INSERT INTO job_event_pages VALUES($1,$2,$3,$4)',[job.id,offset,JSON.stringify(rows),hash]);
          await db.query(`UPDATE fetch_jobs SET checkpoint=$2,lease_until=clock_timestamp()+interval '2 minutes' WHERE id=$1`,[job.id,{signature,offset:next}]);
        });
        records+=rows.length;
        if(job.priority!==4) return;
        const {candidateLimit}=await acquisitionSettings(pool);
        if(await normalAcquisitionReady(pool,candidateLimit)) return false;
      }});
      if(!scan.complete) return await apply(db=>finish(db,'pending',null,new Date(Date.now()+1000)));
      work=async db=>{
        const current=(await db.query('SELECT multiplier,event_date::text FROM events WHERE id=$1',[event.id])).rows[0];
        if(JSON.stringify([current.event_date,current.multiplier])!==signature) throw new Error('Event changed while paging');
        const {rows:pages}=await db.query('SELECT data,page_hash FROM job_event_pages WHERE job_id=$1 ORDER BY page_offset',[job.id]);
        const rows=pages.flatMap(page=>page.data);
        await stage('event_store');
        const {rows:conflicts}=await db.query(`SELECT old.dmp_id FROM event_results old
          JOIN jsonb_to_recordset($2::jsonb) r("dmpId" int,"totalPoints" int) ON r."dmpId"=old.dmp_id
          JOIN tracked_players t ON t.season_id=$3 AND t.dmp_id=old.dmp_id AND t.active
          WHERE old.event_id=$1 AND old.active AND old.source='personal' AND old.total_points<>r."totalPoints"`,
        [event.id,JSON.stringify(rows),season.id]);
        const changed=await storeEvent(db,event,rows,{allowCancellation:map.cancellationVerified===true});
        const hash=createHash('sha256').update(pages.map(page=>page.page_hash).join('|')).digest('hex');
        const ranges=await setting(db,'multiplier_ranges',{});
        const gradeRanges=ranges[event.grade]??{};
        const configured=Object.entries(gradeRanges).find(([multiplier])=>Number(multiplier)===Number(event.multiplier))?.[1];
        const outside=configured==null?null:rows.filter(row=>row.totalPoints>0&&row.placement>configured).length;
        await db.query(`UPDATE events SET result_status='fetched',last_fetched_at=now(),result_hash=$2,range_check=$3,
          first_fetched_at=coalesce(first_fetched_at,last_fetched_at,now()),urgent_fetch=false,
          next_fetch_at=CASE
            WHEN $4 THEN NULL
            WHEN now()-coalesce(first_fetched_at,last_fetched_at,now())>=interval '31 days' THEN NULL
            WHEN now()-coalesce(first_fetched_at,last_fetched_at,now())>=interval '8 days' THEN now()+interval '7 days'
            WHEN now()-coalesce(first_fetched_at,last_fetched_at,now())>=interval '72 hours' THEN now()+interval '1 day'
            WHEN now()-coalesce(first_fetched_at,last_fetched_at,now())>=interval '24 hours' THEN now()+interval '6 hours'
            ELSE now()+interval '1 hour' END WHERE id=$1`,
        [event.id,hash,configured==null?null:{configured,outside},job.priority===4]);
        await db.query('DELETE FROM job_event_pages WHERE job_id=$1',[job.id]);
        await applyPersonalReplay(db,season,changed,stage);
        if(conflicts.length) await enqueuePersonalBatch(db,season.id,conflicts.map(row=>row.dmp_id),
          {reopen:true,priority:2,reason:'event-personal-conflict'});
        await reevaluateEventPlayers(db,season,changed);
      };
    } else if(job.type==='verify-player') {
      const player=(await pool.query('SELECT * FROM players WHERE dmp_id=$1',[p.id])).rows[0];
      if(!player) throw new Error('Unknown player');
      await stage('personal_fetch');
      const rows=await client.personal(player,season,map.personal,{nameCollision:name=>hasNameCollision(pool,player.dmp_id,name)});
      records=rows.length;
      const renew=()=>apply(db=>db.query("UPDATE fetch_jobs SET lease_until=clock_timestamp()+interval '2 minutes' WHERE id=$1",[job.id]));
      await stage('schedule_fetch');
      const events=await collectVerificationEvents(pool,client,season,rows,map.schedule,renew);
      work=async db=>{
        const {rows:[current]}=await db.query('SELECT handle_name FROM players WHERE dmp_id=$1 FOR UPDATE',[p.id]);
        if(current?.handle_name!==player.handle_name) throw new Error('HN changed during personal lookup');
        await stage('verify_calculation');
        await verifyPersonalNameUniqueness(db,player);
        const result=await calculateVerification(db,season,player,rows,events);
        await setSetting(db,verificationKey(season.id,p.id),result);
      };
    } else if(job.type==='personal') {
      const player=(await pool.query('SELECT * FROM players WHERE dmp_id=$1',[p.id])).rows[0];
      if(!player) throw new Error('Unknown player');
      await stage('personal_fetch');
      const rows=await client.personal(player,season,map.personal,{nameCollision:name=>hasNameCollision(pool,player.dmp_id,name)});
      records=rows.length;
      work=async db=>{
        const current=(await db.query('SELECT handle_name FROM players WHERE dmp_id=$1',[p.id])).rows[0];
        if(current.handle_name!==player.handle_name) throw new Error('HN changed during personal lookup');
        await stage('personal_store');
        await verifyPersonalNameUniqueness(db,player);
        const pending=await storePersonal(db,season,p.id,rows);
        await db.query(`INSERT INTO personal_fetch_coverage VALUES($1,$2,now(),$3,least($4::date,(now() AT TIME ZONE 'Asia/Tokyo')::date))
          ON CONFLICT(season_id,dmp_id) DO UPDATE SET succeeded_at=excluded.succeeded_at,
          starts_on=excluded.starts_on,through_on=excluded.through_on`,[season.id,p.id,season.starts_on,season.ends_on]);
        const {rows:conflicts}=await db.query(`SELECT DISTINCT e.id FROM jsonb_to_recordset($3::jsonb)
          x("eventDate" date,"key" jsonb,"totalPoints" int)
          JOIN events e ON e.season_id=$1 AND e.event_date=x."eventDate" AND e.shop_id=(x.key->>'shopId')::int
            AND e.source_event_id=(x.key->>'eventId')::int AND e.held_id=(x.key->>'heldId')::int
          JOIN event_results r ON r.event_id=e.id AND r.dmp_id=$2 AND r.source='event' AND r.active
          WHERE e.multiplier IS NOT NULL AND r.total_points<>x."totalPoints"`,[season.id,p.id,JSON.stringify(rows)]);
        for(const conflict of conflicts) await enqueue(db,'event',{season:season.id,id:conflict.id},'event:'+conflict.id,1,
          {reopen:true,reason:'event-personal-conflict'});
        if(pending||rows.some(row=>!row.totalPoints)) await enqueueCompletion(db,season.id);
        const {rows:[latest]}=await db.query('SELECT max(aggregation_at) AS time FROM official_rankings WHERE season_id=$1',[season.id]);
        if(latest.time) {
          await stage('official_reconcile');
          await reconcile(db,season,latest.time,p.id,{queueMismatch:false});
        }
        await stage('recalculate');
        await recalculate(db,season.id,[p.id]);
      };
    } else if(job.type==='tracking') {
      work=async db=>{
        await stage('tracking');
        const {rows:[previous]}=await db.query('SELECT id FROM seasons WHERE ends_on<$1 ORDER BY ends_on DESC LIMIT 1',[season.starts_on]);
        if(previous && !await setting(db,'rollover:'+season.id,false)) {
          const {rows:carry}=await db.query(`SELECT dmp_id,'previous' reason FROM official_rankings WHERE season_id=$1 AND rank<=200
            UNION SELECT dmp_id,'previous' FROM provisional_rankings WHERE season_id=$1 AND rank<=200
            UNION SELECT dmp_id,'watch' FROM tracked_players WHERE season_id=$1 AND 'watch'=ANY(reasons)
              AND last_requested_at>=now()-interval '30 days'`,[previous.id]);
          for(const row of carry) {
            await track(db,season.id,row.dmp_id,row.reason);
            if(row.reason==='watch') await db.query(`UPDATE tracked_players new SET last_requested_at=old.last_requested_at
              FROM tracked_players old WHERE new.season_id=$1 AND new.dmp_id=$2 AND old.season_id=$3 AND old.dmp_id=new.dmp_id
              AND (new.last_requested_at IS NULL OR (new.last_requested_at=now() AND NOT ('official'=ANY(new.reasons))))`,[season.id,row.dmp_id,previous.id]);
          }
          await setSetting(db,'rollover:'+season.id,true);
        }
        const {rows:held}=await db.query(`SELECT DISTINCT (payload->>'id')::int id FROM fetch_jobs
          WHERE NOT legacy_queue AND type='personal' AND status='held' AND (reason LIKE 'hold-%' OR reason LIKE 'qualify-%') AND payload->>'season'=$1::bigint::text
          UNION SELECT dmp_id FROM tracking_candidate_decisions WHERE season_id=$1 AND details->>'decision' LIKE 'qualify-%'`,[season.id]);
        const key='tracking-dirty:'+season.id;
        const pending=p.dirty?await setting(db,key,[]):[];
        const ids=[...new Set([...held.map(row=>row.id),...pending])];
        await planTracking(db,season,{evaluateCandidates:ids.length>0,playerIds:ids});
        if(p.dirty) await db.query('DELETE FROM app_settings WHERE key=$1',[key]);
        if((await uncoveredDates(db,season.id)).length) await enqueueCompletion(db,season.id);
        await stage('recalculate');
        await recalculate(db,season.id,[]);
      };
    } else if(job.type==='recalculate') {
      work=async db=>{await stage('recalculate');await recalculate(db,season.id);};
    }
    else if(job.type==='maintenance') {
      await stage('maintenance');
      if(backup) await backup().catch(()=>console.error('Scheduled backup failed'));
      work=async db=>{
        await stage('maintenance');
        await db.query(`DELETE FROM fetch_logs WHERE created_at<now()-CASE WHEN error IS NULL THEN interval '30 days' ELSE interval '90 days' END`);
        await db.query(`DELETE FROM fetch_jobs WHERE status='done' AND created_at<now()-interval '90 days'`);
        await db.query('DELETE FROM admin_sessions WHERE expires_at<now()');
        const {rows}=await db.query(`SELECT id FROM seasons WHERE compacted_at IS NULL AND finalized_at<=now()-interval '30 days' ORDER BY id FOR UPDATE`);
        for(const row of rows) await compactHistory(db,row.id);
      };
    } else if(job.type==='backup') {
      await stage('backup');
      if(backup) await backup(true);
    } else throw new Error('Unknown job type');
    await stage('waiting_lock');
    await apply(async db=>{
      await work(db);
      await finish(db,'done',null,job.type==='complete-schedule'?new Date(Date.now()+(completionFetched?86400000:0)):null);
      if(job.type==='tracking') {
        const key='tracking-dirty:'+season.id;
        const pending=await setting(db,key,[]);
        if(pending.length) await enqueue(db,'tracking',{season:season.id,dirty:true},'tracking:followup:'+job.id,2);
      }

    });
  } catch(error) {
    if(error.message==='Lease expired') {
      await releaseUnusedSlots(pool,job);
      return;
    }
    if(error.deferred) {
      try {
        return await apply(async db=>{
          await finish(db,error.hold?'held':'pending',null,new Date(error.retryAt),{unused:true});
          if(error.hold) await db.query("UPDATE fetch_jobs SET reason='hold-reevaluation' WHERE id=$1",[job.id]);
        });
      } catch(failure) {
        if(failure.message!=='Lease expired') throw failure;
        await releaseUnusedSlots(pool,job);
        return;
      }
    }
    const next=new Date(Math.max(Date.now()+[60000,300000,900000,3600000][Math.min(job.attempts,3)],error.retryAt??0));
    const message=['DMP requests','DMP HTTP','Invalid','Unexpected','Unknown','Missing','Unrecognized','Official snapshot','Unverified official','Conflicting','Repeated','Schedule response','Personal history','HN ','Event changed','DMP cooldown'].some(prefix=>error.message.startsWith(prefix))
      ? error.message.slice(0,160) : 'Job failed ('+(error.code ?? error.name ?? 'error')+')';
    try {
      await apply(async db=>{
        if(error.retryAt) await extendDmpCooldown(db,error.retryAt);
        if(job.type==='personal') {
          await db.query(`UPDATE tracked_players SET backfill_status=CASE WHEN backfill_status IN ('ready','stale') THEN 'stale' ELSE 'partial' END
            WHERE season_id=$1 AND dmp_id=$2`,[job.payload.season,job.payload.id]);
          await db.query("UPDATE provisional_rankings SET status='stale' WHERE season_id=$1 AND dmp_id=$2",[job.payload.season,job.payload.id]);
        }
        await finish(db,error.eventInteger?'held':job.attempts>=3?'failed':'pending',message,next);
      });
    } catch(failure) {
      if(failure.message!=='Lease expired') throw failure;
    }
  } finally {
    clearInterval(heartbeat);
  }
}
export function startWorker(pool,options={}) {
  let stopping=false;
  let busy=false;
  let drained;
  let awake=0;
  let retryTimer;
  async function kick() {
    if(stopping||busy) return;
    busy=true;
    clearTimeout(retryTimer);
    awake=Date.now()+120000;
    try {
      await measureDatabase(pool);
      const lane=async()=>{
        while(!stopping&&Date.now()<awake) {
          const job=await claimAcquisition(pool,process.env.ALLOW_DMP_FETCH==='true');
          if(!job) break;
          await runJob(pool,job,options);
        }
      };
      const results=await Promise.allSettled([lane(),lane()]);
      if(results.some(result=>result.status==='rejected')) console.error('A worker lane failed');
      if(!stopping&&!await setting(pool,'paused',false)) {
        const {rows:[next]}=await pool.query(`WITH timing AS (
          SELECT to_timestamp(coalesce((SELECT (value #>> '{}')::double precision
            FROM app_settings WHERE key='dmp_next_request'),0)/1000) AS cooldown
        )
        SELECT min(CASE WHEN j.type=ANY($2) AND cooldown>now()
          THEN greatest(j.next_run_at,cooldown,CASE WHEN j.status='running' THEN j.lease_until END)
          WHEN j.status='pending' AND j.next_run_at<=now()+interval '16 minutes'
            AND j.next_run_at>now() THEN j.next_run_at END) AS at
        FROM fetch_jobs j CROSS JOIN timing
        WHERE (j.status IN ('pending','failed') OR j.status='running' AND cooldown>now()) AND NOT j.legacy_queue
          AND ($1 OR NOT (j.type=ANY($2)))`,
        [process.env.ALLOW_DMP_FETCH==='true',externalTypes]);
        const retake=()=>kick().catch(()=>console.error('Worker retry failed'));
        if(next.at) retryTimer=setTimeout(retake,Math.min(2147483647,Math.max(250,+new Date(next.at)-Date.now()+20))).unref();
        else if(Date.now()>=awake) retryTimer=setTimeout(retake,1000).unref();
      }
    } finally {busy=false;drained?.();}
  }
  return {kick,stop:()=>{
    stopping=true;
    clearTimeout(retryTimer);
    if(busy) return new Promise(resolve=>{
      const previous=drained;
      drained=()=>{previous?.();resolve();};
    });
    return Promise.resolve();
  }};
}
