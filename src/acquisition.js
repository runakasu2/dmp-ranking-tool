import {displayName} from './handle-name.js';
import {setting,setSetting} from './ranking.js';

export const externalTypes=['official','official-only','schedule','event','personal','verify-player','complete-schedule'];
export const defaults={backfillEnabled:true,backfillLimit:50,candidateLimit:50,personalDays:7,trafficBudget:null};
export const acquisitionSettings=async db=>({...defaults,dbBudget:Number(process.env.DB_BUDGET_BYTES??500000000),
  ...await setting(db,'acquisition',{})});

export function restriction(traffic, database) {
  const rate=Math.max(traffic??0,database??0);
  return rate>=.95?3:rate>=.90?2:rate>=.80?1:0;
}

export async function usage(db) {
  const configuration=await acquisitionSettings(db);
  const {rows:[row]}=await db.query(`SELECT sum(bytes)::text traffic,max(measured_at) traffic_at,
    ((now() AT TIME ZONE 'Asia/Tokyo')::date-29)::text traffic_from,
    (now() AT TIME ZONE 'Asia/Tokyo')::date::text traffic_through,
    min(day)::text AS traffic_first_day,
    (SELECT value FROM app_settings WHERE key='database_measurement_failed') AS database_error_at,
    (SELECT value FROM app_settings WHERE key='database_bytes') database,
    (SELECT updated_at FROM app_settings WHERE key='database_bytes') database_at
    FROM dmp_traffic_daily WHERE day>=(now() AT TIME ZONE 'Asia/Tokyo')::date-29`);
  const trafficRate=row.traffic==null||configuration.trafficBudget==null?null:Number(row.traffic)/configuration.trafficBudget;
  const databaseRate=row.database==null?null:Number(row.database)/configuration.dbBudget;
  return {...row,configuration,trafficRate,databaseRate,level:restriction(trafficRate,databaseRate)};
}

export async function measureDatabase(db) {
  const {rows:[probe]}=await db.query(`SELECT EXISTS (SELECT 1 FROM app_settings
    WHERE key='database_bytes' AND updated_at>=now()-interval '5 minutes') AS recent`);
  if(probe.recent) return;
  try {
    const {rows:[row]}=await db.query('SELECT pg_database_size(current_database()) AS bytes');
    await setSetting(db,'database_bytes',Number(row.bytes));
    await db.query("DELETE FROM app_settings WHERE key='database_measurement_failed'");
  } catch {
    await setSetting(db,'database_measurement_failed',new Date().toISOString());
  }
}

export async function candidates(db,seasonId,ids=null,{schemaReady=true}={}) {
  const registration=schemaReady?'e.registration_transition_at':'NULL::timestamptz';
  const {rows}=await db.query(`WITH cutoff AS (
    SELECT max(aggregation_at) time FROM official_rankings WHERE season_id=$1
  ), border AS (
    SELECT points FROM provisional_rankings WHERE season_id=$1 AND status='ready' ORDER BY points DESC OFFSET 199 LIMIT 1
  ), rule AS (
    SELECT weekly_limit,grade_rules FROM aggregation_rules WHERE season_id=$1 ORDER BY version DESC LIMIT 1
  ), evidence AS (
    SELECT r.dmp_id,r.event_id,r.total_points,
      CASE WHEN e.official_reflected_at<=c.time AND (r.source_updated_at IS NULL OR r.source_updated_at<=c.time)
        THEN 0
        WHEN e.event_date>(c.time AT TIME ZONE 'Asia/Tokyo')::date OR ${registration}>c.time
        THEN r.total_points ELSE greatest(r.total_points-coalesce((
          SELECT (ch.changed_fields->'total_points'->>'before')::int FROM event_result_changes ch
          WHERE ch.event_result_id=r.id AND coalesce(ch.source_updated_at,ch.detected_at)>c.time
            AND ch.changed_fields ? 'total_points' AND (e.official_reflected_at<=c.time OR EXISTS (
              SELECT 1 FROM sync_discrepancies d WHERE d.season_id=e.season_id AND d.dmp_id=r.dmp_id
                AND d.aggregation_at=c.time AND d.status='match'))
          ORDER BY coalesce(ch.source_updated_at,ch.detected_at),ch.id LIMIT 1
        ),0),0) END AS potential,rule.grade_rules->>e.grade AS mode,rule.weekly_limit,
      date_trunc('week',e.event_date::timestamp) AS week,
      EXISTS(SELECT 1 FROM sync_discrepancies d WHERE d.season_id=e.season_id AND d.dmp_id=r.dmp_id
        AND d.aggregation_at=c.time AND d.status='match') AS checked,
      (e.event_date>(c.time AT TIME ZONE 'Asia/Tokyo')::date OR r.source_updated_at>c.time
        OR ${registration}>c.time) IS TRUE AS recent
    FROM event_results r JOIN events e ON e.id=r.event_id CROSS JOIN cutoff c CROSS JOIN rule
    WHERE e.season_id=$1 AND r.active AND r.total_points>0 AND ($2::int[] IS NULL OR r.dmp_id=ANY($2))
  ), baseline AS (
    SELECT *,CASE WHEN recent THEN total_points-potential ELSE total_points END old_points FROM evidence
  ), trimmed AS (
    SELECT *, row_number() OVER (PARTITION BY dmp_id,week,mode ORDER BY old_points DESC,event_id) old_slot,
      row_number() OVER (PARTITION BY dmp_id,week,mode ORDER BY total_points DESC,event_id) known_slot,
      row_number() OVER (PARTITION BY dmp_id,week,mode,recent ORDER BY potential DESC,event_id) gain_slot
    FROM baseline WHERE mode IN ('weekly','extra')
  ), sums AS (
    SELECT dmp_id,sum(total_points) FILTER(WHERE mode='extra' OR known_slot<=weekly_limit) known,
      sum(potential) FILTER(WHERE recent AND (mode='extra' OR gain_slot<=weekly_limit)) gain,
      sum(old_points) FILTER(WHERE mode='extra' OR old_slot<=weekly_limit) old_known,
      bool_or(checked) checked,count(*) FILTER(WHERE recent)::int evidence_count FROM trimmed GROUP BY dmp_id
  ), estimated AS (
    SELECT s.*,CASE WHEN s.checked AND s.old_known=o.points THEN greatest(s.known-s.old_known,0)
      ELSE coalesce(s.gain,0) END increment
    FROM sums s LEFT JOIN official_rankings o ON o.season_id=$1 AND o.dmp_id=s.dmp_id
  )
  SELECT s.dmp_id,o.rank,o.points official_points,b.points border,s.known::int,s.increment::int gain,s.evidence_count,
    (CASE WHEN o.dmp_id IS NULL THEN s.known ELSE o.points+s.increment END)::int upper,
    CASE WHEN o.rank<=200 THEN 'official-top'
      WHEN b.points IS NULL THEN 'hold-no-border'
      WHEN o.dmp_id IS NULL AND s.known>=b.points THEN 'qualify-known-results'
      WHEN s.increment=0 THEN 'hold-no-post-cutoff-evidence'
      WHEN o.dmp_id IS NULL THEN 'hold-no-official-baseline'
      WHEN o.points+s.increment>=b.points THEN 'qualify-upper-bound'
      ELSE 'below-border' END AS decision
  FROM estimated s CROSS JOIN cutoff c LEFT JOIN border b ON true
  LEFT JOIN official_rankings o ON o.season_id=$1 AND o.dmp_id=s.dmp_id`,[seasonId,ids]);
  return rows;
}

export async function candidatePreview(db,seasonId,ids=null,evaluated=null) {
  evaluated??=await candidates(db,seasonId,ids);
  const configuration=await acquisitionSettings(db);
  const {rows:[quota]}=await db.query(`SELECT
    (SELECT points FROM provisional_rankings WHERE season_id=$1 AND status='ready' ORDER BY points DESC OFFSET 199 LIMIT 1) border,
    (SELECT count(*)::int FROM candidate_daily_players WHERE day=(now() AT TIME ZONE 'Asia/Tokyo')::date) occupied,
    (SELECT count(*)::int FROM candidate_daily_players c WHERE c.day=(now() AT TIME ZONE 'Asia/Tokyo')::date
      AND (c.reservation_token IS NULL OR NOT EXISTS(SELECT 1 FROM fetch_jobs j
        WHERE j.lease_token=c.reservation_token AND j.status='running' AND j.lease_until>clock_timestamp()))) used,
    (SELECT count(*)::int FROM fetch_jobs j WHERE j.type='personal' AND j.priority=2
      AND j.reason LIKE 'border-candidate%' AND j.status IN ('pending','running','failed') AND NOT EXISTS (
        SELECT 1 FROM candidate_daily_players c WHERE c.day=(now() AT TIME ZONE 'Asia/Tokyo')::date AND c.dmp_id=(j.payload->>'id')::int)) outstanding,
    (SELECT round(coalesce(avg(l.received_bytes),avg(l.bytes)))::int FROM fetch_logs l JOIN fetch_jobs j ON j.id=l.job_id
      WHERE j.type='personal' AND l.status='done' AND l.bytes>0 AND l.created_at>=now()-interval '30 days') average,
    NOT EXISTS(SELECT 1 FROM fetch_logs l JOIN fetch_jobs j ON j.id=l.job_id WHERE j.type='personal'
      AND l.status='done' AND l.received_bytes IS NOT NULL AND l.created_at>=now()-interval '30 days') approximate`,[seasonId]);
  const {rows:players}=await db.query(`SELECT p.dmp_id,p.handle_name,t.active,t.backfill_status,
    j.status job_status FROM players p LEFT JOIN tracked_players t ON t.dmp_id=p.dmp_id AND t.season_id=$1
    LEFT JOIN fetch_jobs j ON j.dedupe_key='personal:'||$1::bigint::text||':'||p.dmp_id
    WHERE p.dmp_id=ANY($2::int[])`,[seasonId,evaluated.map(row=>row.dmp_id)]);
  const lookup=new Map(players.map(row=>[row.dmp_id,{...row,display_name:displayName(row.handle_name)}]));
  const rows=evaluated.map(row=>({...row,...lookup.get(row.dmp_id)}))
    .filter(row=>row.decision!=='official-top')
    .sort((a,b)=>(b.upper??0)-(a.upper??0)||a.dmp_id-b.dmp_id);
  const remaining=Math.max(0,configuration.candidateLimit-quota.occupied-quota.outstanding);
  const eligible=rows.filter(row=>row.decision.startsWith('qualify-')&&
    (!row.active||row.backfill_status==='pending')&&!['pending','running','failed'].includes(row.job_status));
  const selected=eligible.slice(0,remaining);
  const selectedIds=new Set(selected.map(row=>row.dmp_id));
  const eligibleIds=new Set(eligible.map(row=>row.dmp_id));
  for(const row of rows) row.category=selectedIds.has(row.dmp_id)?'selected':eligibleIds.has(row.dmp_id)?'daily-limit':row.decision;
  const {rows:[existing]}=await db.query(`SELECT count(*)::int held FROM fetch_jobs WHERE type='personal' AND status='held'
    AND payload->>'season'=$1::text AND (reason LIKE 'hold-%' OR reason LIKE 'qualify-%')`,[seasonId]);
  return {rows,selected,border:quota.border,used:quota.used,remaining,limit:configuration.candidateLimit,
    held:rows.filter(row=>row.decision.startsWith('hold-')).length,below:rows.filter(row=>row.decision==='below-border').length,
    existingHeld:existing.held,eligible:eligible.length,
    estimatedBytes:quota.average==null?null:quota.average*selected.length,approximate:quota.approximate};
}

export function eventPriority(event,day) {
  if(event.urgent_fetch||!event.last_fetched_at&&event.registration_transition_at) return {priority:1,reason:'event-change'};
  if(event.last_fetched_at) return {priority:3,reason:'event-periodic'};
  const recent=Date.parse(day)-Date.parse(event.event_date)<=7*86400000;
  return recent?{priority:1,reason:'event-first'}:{priority:4,reason:'historical-event'};
}

export async function queueReview(db,{apply=false}={}) {
  if(apply) await db.query('SELECT pg_advisory_xact_lock(440004)');
  const paused=await setting(db,'paused',false);
  const {rows:[clock]}=await db.query(`SELECT ((now() AT TIME ZONE 'Asia/Tokyo')::date)::text AS day,
    EXISTS(SELECT 1 FROM fetch_jobs WHERE status='running') running`);
  if(apply&&(!paused||clock.running)) throw Object.assign(new Error('取得を停止し、実行中ジョブの終了を待ってください'),{status:409});
  const {rows:events}=await db.query(`SELECT j.id,j.priority,j.reason,e.event_name,e.event_date::text,e.last_fetched_at,
    e.urgent_fetch,e.registration_transition_at FROM fetch_jobs j JOIN events e ON e.id::text=j.payload->>'id'
    WHERE j.status='pending' AND NOT j.legacy_queue AND j.type='event' AND j.priority=1
    ORDER BY e.event_date,j.id`);
  const {rows:duplicates}=await db.query(`SELECT id,season,priority,duplicate_of FROM (
    SELECT id,status,priority,payload->>'season' season,
      first_value(id) OVER(PARTITION BY payload->>'season' ORDER BY (status='running') DESC,id) duplicate_of
    FROM fetch_jobs WHERE type='tracking' AND status IN ('pending','running') AND NOT legacy_queue
  ) q WHERE status='pending' AND id<>duplicate_of ORDER BY id`);
  const {rows:counts}=await db.query("SELECT priority,count(*)::int n FROM fetch_jobs WHERE status='pending' GROUP BY priority");
  const changes=events.map(event=>{
    const historical=event.reason==='event-first'&&eventPriority(event,clock.day).priority===4;
    return {id:event.id,name:event.event_name,date:event.event_date,priority:1,nextPriority:historical?4:1,
      reason:historical?'historical-event':event.reason!=='event-first'?event.reason:event.last_fetched_at?'already-fetched':eventPriority(event,clock.day).reason};
  });
  const demoted=changes.filter(row=>row.nextPriority===4);
  const projected=Object.fromEntries(Array.from({length:5},(_,i)=>[i,counts.find(row=>row.priority===i)?.n??0]));
  projected[1]-=demoted.length;
  for(const duplicate of duplicates) projected[duplicate.priority]--;
  projected[4]+=demoted.length;
  const {backfillLimit}=await acquisitionSettings(db);
  const {rows:[quota]}=await db.query(`SELECT count(*) FILTER(WHERE j.type='event' AND j.status='pending' AND j.priority=4)::int events,
    (SELECT count(*)::int FROM backfill_daily_events WHERE day=$1::date) used,
    (now() AT TIME ZONE 'Asia/Tokyo')::time<time '12:00' window_open FROM fetch_jobs j`,[clock.day]);
  const today=quota.window_open?Math.max(0,backfillLimit-quota.used):0;
  const total=quota.events+demoted.length;
  const days=total===0?0:today>0?1+Math.ceil(Math.max(0,total-today)/backfillLimit):Math.ceil(total/backfillLimit);
  if(apply) {
    if(demoted.length) await db.query(`UPDATE fetch_jobs SET priority=4,reason='historical-event'
      WHERE status='pending' AND id=ANY($1::bigint[])`,[demoted.map(row=>row.id)]);
    if(duplicates.length) await db.query(`UPDATE fetch_jobs SET status='cancelled',reason='duplicate-tracking'
      WHERE status='pending' AND id=ANY($1::bigint[])`,[duplicates.map(row=>row.id)]);
  }
  return {changes,duplicates,projected,days,retained:changes.length-demoted.length,demoted:demoted.length,
    canApply:paused&&!clock.running};
}

export async function queueMigration(db,{apply=false}={}) {
  const {rows:[schema]}=await db.query(`SELECT EXISTS(
    SELECT 1 FROM information_schema.columns WHERE table_schema=current_schema() AND table_name='fetch_jobs'
      AND column_name='legacy_queue') AS ready`);
  if(apply) {
    if(!schema.ready) throw new Error('Apply migration 006 first');
    // Serialize with worker claims. The caller must hold a transaction.
    await db.query('SELECT pg_advisory_xact_lock(440004)');
    if(!await setting(db,'paused',false)) throw new Error('Pause acquisition before migrating the queue');
    if((await db.query("SELECT 1 FROM fetch_jobs WHERE status='running' LIMIT 1")).rows.length) {
      throw new Error('Running jobs must finish before migrating the queue');
    }
  }
  const {rows}=await db.query(`SELECT j.id,j.type,j.status,j.priority,j.payload,j.dedupe_key,
    ${schema.ready?"j.legacy_queue,e.urgent_fetch":"true AS legacy_queue,false AS urgent_fetch"},j.checkpoint,
    o.rank,t.backfill_status,
    EXISTS(SELECT 1 FROM pending_personal_results p WHERE p.season_id=t.season_id AND p.dmp_id=t.dmp_id
      AND (p.data->>'totalPoints')::int>0) AS stored,
    e.event_date::text,e.last_fetched_at
    FROM fetch_jobs j LEFT JOIN official_rankings o ON o.season_id::text=j.payload->>'season'
      AND o.dmp_id::text=j.payload->>'id' AND j.type='personal'
    LEFT JOIN tracked_players t ON t.season_id::text=j.payload->>'season'
      AND t.dmp_id::text=j.payload->>'id' AND j.type='personal'
    LEFT JOIN events e ON e.id::text=j.payload->>'id' AND j.type='event'
    WHERE j.status IN ('pending','failed','held') ORDER BY j.priority,j.id`);
  const old=rows.filter(row=>row.legacy_queue);
  const evaluated=new Map();
  for(const [season,group] of Object.entries(Object.groupBy(old.filter(row=>row.type==='personal'),row=>row.payload.season))) {
    for(const row of await candidates(db,season,group.map(job=>job.payload.id),{schemaReady:schema.ready})) evaluated.set(season+':'+row.dmp_id,row);
  }
  const canonical=new Map();
  for(const job of rows) if(!job.legacy_queue&&['pending','failed'].includes(job.status)&&['personal','event','official'].includes(job.type)) {
    canonical.set(job.type+':'+job.payload.season+':'+job.payload.id,job.id);
  }
  const {rows:[clock]}=await db.query("SELECT ((now() AT TIME ZONE 'Asia/Tokyo')::date-30)::text cutoff");
  const changes=old.map(job=>{
    const p=job.payload;
    const target=job.type+':'+p.season+':'+p.id;
    const evidence=evaluated.get(p.season+':'+p.id);
    let priority=2,status=job.status,reason='legacy-maintenance';
    if(job.type==='personal') {
      if(job.priority===4) {priority=0;reason='administrator';}
      else if(job.dedupe_key.startsWith('reconcile:')) reason='official-mismatch';
      else if(job.rank<=200&&job.rank!=null) {
        priority=1;reason='official-top-coverage';
        if(job.backfill_status==='ready') {status='cancelled';reason='official-top-already-ready';}
        else if(job.stored&&job.backfill_status==='partial') {status='cancelled';reason='reuse-stored-personal';}
      } else {
        reason=evidence?.decision??'hold-no-evidence';
        if(reason==='below-border') status='cancelled';
        else if(!reason.startsWith('qualify-')) status='held';
      }
    } else if(job.type==='event') {
      if(!job.event_date) {status='held';reason='missing-event';}
      else if(job.priority===2) {priority=0;reason='administrator';}
      else if(job.urgent_fetch) {priority=1;reason='event-change';}
      else if(job.event_date < clock.cutoff) {
        priority=4;reason='historical-event';
        if(job.last_fetched_at&&!job.checkpoint) {status='cancelled';reason='historical-already-fetched';}
      } else {priority=job.last_fetched_at?3:1;reason=job.last_fetched_at?'event-periodic':'event-first';}
    } else if(job.type.startsWith('official')||job.type==='verify-player'||job.type==='recalculate'||job.type==='backup') {
      priority=0;reason='legacy-priority';
    } else if(job.type==='schedule') {
      priority=job.dedupe_key.startsWith('history:')?4:2;
      reason=priority===4?'historical-discovery':'schedule';
    } else if(job.type.startsWith('complete-')) reason='missing-events';
    if(['personal','event','official'].includes(job.type)&&['pending','failed'].includes(status)) {
      if(canonical.has(target)) {status='cancelled';reason='duplicate-target';}
      else canonical.set(target,job.id);
    }
    return {id:job.id,type:job.type,status,priority,reason,evidence,
      detail:evidence?reason+' '+JSON.stringify(evidence):reason};
  });
  if(apply&&changes.length) await db.query(`UPDATE fetch_jobs j SET priority=x.priority,status=x.status,reason=x.detail,legacy_queue=false
    FROM jsonb_to_recordset($1::jsonb) x(id bigint,priority integer,status text,detail text)
    WHERE j.id=x.id AND j.legacy_queue AND j.status IN ('pending','failed','held')`,[JSON.stringify(changes)]);
  return changes;
}

export async function heldResultReview(db,seasonId,{apply=false}={}) {
  if(apply) await db.query('SELECT pg_advisory_xact_lock(440004)');
  const paused=await setting(db,'paused',false);
  const {rows:[state]}=await db.query("SELECT EXISTS(SELECT 1 FROM fetch_jobs WHERE status='running') running");
  const canApply=paused&&!state.running;
  if(apply&&!canApply) throw Object.assign(new Error('取得を停止し、実行中ジョブの終了を待ってください'),{status:409});
  const {rows}=await db.query(`SELECT j.id,j.last_error,j.checkpoint->>'offset' AS offset,e.event_name,
    CASE WHEN j.last_error LIKE '% [placement] value=""' THEN 'blank-placement-legacy'
      WHEN j.last_error LIKE '% [placement] % points=positive' THEN 'blank-placement-positive'
      WHEN j.last_error LIKE '% [placement] % points=unconfirmed' THEN 'blank-placement-unconfirmed'
      ELSE 'other' END AS category
    FROM fetch_jobs j LEFT JOIN events e ON e.id::text=j.payload->>'id'
    WHERE j.type='event' AND j.status='held' AND NOT j.legacy_queue AND j.payload->>'season'=$1::text
    ORDER BY j.id`,[seasonId]);
  const retry=rows.filter(row=>row.category==='blank-placement-legacy');
  const counts=Object.fromEntries(Object.entries(Object.groupBy(rows,row=>row.category)).map(([key,group])=>[key,group.length]));
  if(apply&&retry.length) await db.query(`UPDATE fetch_jobs SET status='pending',next_run_at=now()
    WHERE id=ANY($1::bigint[]) AND type='event' AND status='held' AND last_error LIKE '% [placement] value=""'`,[retry.map(row=>row.id)]);
  return {canApply,counts,rows,retry:retry.length,needsInvestigation:rows.length-retry.length};
}
