import {grades} from './dmp.js';

const daysBetween=(date,days)=>new Date(Date.parse(date)+days*86400000).toISOString().slice(0,10);
export async function uncoveredDates(db,seasonId,from=null,to=null) {
  const {rows}=await db.query(`SELECT DISTINCT p.data->>'eventDate' AS day
    FROM pending_personal_results p JOIN seasons s ON s.id=p.season_id
    WHERE p.season_id=$1 AND p.data->'key'->>'shopId' IS NOT NULL
      AND p.data->>'eventDate' BETWEEN coalesce($2,s.starts_on::text) AND coalesce($3,s.ends_on::text)
      AND NOT EXISTS(SELECT 1 FROM events e WHERE e.season_id=p.season_id
        AND e.event_date::text=p.data->>'eventDate' AND e.shop_id::text=p.data->'key'->>'shopId'
        AND e.source_event_id::text=p.data->'key'->>'eventId' AND e.held_id::text=p.data->'key'->>'heldId')
    ORDER BY 1`,[seasonId,from,to]);
  return rows.map(row=>row.day);
}

export async function planCompletion(db,season) {
  const windows=new Map();
  for(const day of await uncoveredDates(db,season.id)) {
    const weekday=new Date(day).getUTCDay();
    const monday=daysBetween(day,-((weekday+6)%7));
    const from=[monday,season.starts_on].sort().at(-1);
    const to=[daysBetween(monday,6),season.ends_on].sort()[0];
    if(!windows.has(from)) windows.set(from,{to,days:[]});
    windows.get(from).days.push(day);
  }
  for(const [from,{to,days}] of windows) for(const grade of grades) {
    const {rows:[covered]}=await db.query(`SELECT id,status,priority FROM fetch_jobs WHERE type='schedule'
      AND payload->>'season'=$1 AND payload->>'grade'=$2 AND NOT coalesce((payload->>'upcoming')::boolean,false)
      AND NOT legacy_queue AND (status IN ('pending','running') OR (status='done' AND EXISTS(
        SELECT 1 FROM fetch_logs WHERE job_id=fetch_jobs.id AND status='done' AND created_at>=now()-interval '1 day')))
      AND payload->>'from'<=($3::text[])[1] AND payload->>'to'>=($3::text[])[cardinality($3)]
      ORDER BY CASE WHEN status='pending' THEN priority ELSE 0 END,id
      LIMIT 1`,[String(season.id),grade,days]);
    if(covered) {
      if(covered.status==='pending'&&covered.priority>2) await db.query(`UPDATE fetch_jobs SET priority=2,reason='missing-events',
        next_run_at=now() WHERE id=$1 AND status='pending'`,[covered.id]);
      continue;
    }
    await db.query(`INSERT INTO fetch_jobs(type,payload,dedupe_key,priority)
      VALUES('complete-schedule',$1,$2,2)
      ON CONFLICT(dedupe_key) DO UPDATE SET status='pending',attempts=0,next_run_at=now(),last_error=NULL,started_at=NULL,finished_at=NULL
      WHERE NOT fetch_jobs.legacy_queue AND fetch_jobs.status='done' AND fetch_jobs.next_run_at<=now()`,
    [{season:season.id,grade,from,to},['complete-schedule',season.id,grade,from,to].join(':')]);
  }
}

export async function completionProgress(db,seasonId) {
  const {rows:[counts]}=await db.query(`WITH tracked AS (
    SELECT t.dmp_id,t.backfill_status,r.status ranking,
      (t.backfill_status IN ('ready','stale') OR EXISTS (SELECT 1 FROM pending_personal_results p
        WHERE p.season_id=t.season_id AND p.dmp_id=t.dmp_id) OR EXISTS (SELECT 1 FROM fetch_jobs j
        WHERE j.type='personal' AND j.status='done' AND j.payload->>'season'=t.season_id::text
          AND j.payload->>'id'=t.dmp_id::text)) fetched
    FROM tracked_players t LEFT JOIN provisional_rankings r USING(season_id,dmp_id)
    WHERE t.season_id=$1 AND 'official'=ANY(t.reasons)
  ), missing AS (
    SELECT count(*)::int AS details,count(*) FILTER(WHERE (data->>'totalPoints')::int>0)::int positive,
      count(DISTINCT (data->>'eventDate', data->'key')) FILTER(WHERE data->'key'->>'shopId' IS NOT NULL)::int events
    FROM pending_personal_results WHERE season_id=$1
  ), jobs AS (
    SELECT count(*) FILTER(WHERE status='pending')::int pending,count(*) FILTER(WHERE status='running')::int running,
      count(*) FILTER(WHERE status='done')::int done,count(*) FILTER(WHERE status='failed')::int failed,
      count(*) FILTER(WHERE status='held')::int held,count(*) FILTER(WHERE status='cancelled')::int cancelled
    FROM fetch_jobs WHERE payload->>'season'=$1::text AND type IN ('personal','complete-schedule','complete-personal','schedule','event')
  )
  SELECT (SELECT count(*)::int FROM tracked) total,(SELECT count(*)::int FROM tracked WHERE fetched) fetched,
    (SELECT count(*)::int FROM tracked WHERE backfill_status='ready') matched,
    (SELECT count(*)::int FROM tracked WHERE backfill_status='ready' AND ranking='ready') calculated,
    missing.*,jobs.* FROM missing CROSS JOIN jobs`,[seasonId]);
  return counts;
}
