export const defaultRules = {CS:'weekly',CSE:'extra',GP:'extra',BN:'extra'};
export async function seasonLock(db, seasonId) {
  await db.query('SELECT id FROM seasons WHERE id=$1 FOR UPDATE',[seasonId]);
}
export async function setting(db,key,fallback=null) {
  return (await db.query('SELECT value FROM app_settings WHERE key=$1',[key])).rows[0]?.value ?? fallback;
}
export async function setSetting(db,key,value) {
  await db.query(`INSERT INTO app_settings(key,value) VALUES($1,$2)
    ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=now() WHERE app_settings.value IS DISTINCT FROM excluded.value`,[key,JSON.stringify(value)]);
}
const playerInput='jsonb_to_recordset($1::jsonb) AS x("dmpId" int,name text,prefecture text,region text)';
async function savePlayers(db,players) {
  if(!players.length) return;
  const input=JSON.stringify(players);
  const {rows:changed}=await db.query(`INSERT INTO players(dmp_id,handle_name,prefecture,region)
    SELECT "dmpId",name,prefecture,region FROM ${playerInput} ORDER BY "dmpId"
    ON CONFLICT(dmp_id) DO UPDATE SET handle_name=excluded.handle_name,prefecture=coalesce(excluded.prefecture,players.prefecture),
    region=coalesce(excluded.region,players.region),updated_at=now()
    WHERE (players.handle_name,players.prefecture,players.region) IS DISTINCT FROM
      (excluded.handle_name,coalesce(excluded.prefecture,players.prefecture),coalesce(excluded.region,players.region))
    RETURNING dmp_id,handle_name`,[input]);
  if(changed.length) await db.query(`INSERT INTO player_name_history(dmp_id,name)
    SELECT x.dmp_id,x.handle_name FROM jsonb_to_recordset($1::jsonb) AS x(dmp_id int,handle_name text)
    WHERE x.handle_name IS DISTINCT FROM (SELECT name FROM player_name_history WHERE dmp_id=x.dmp_id ORDER BY observed_at DESC LIMIT 1)`,
  [JSON.stringify(changed)]);
}
export async function savePlayer(db,player) {
  await savePlayers(db,[player]);
}
export async function trackMany(db,season,ids,reason) {
  if(!ids.length) return;
  await db.query(`INSERT INTO tracked_players(season_id,dmp_id,reasons,last_requested_at)
    SELECT $1,id,ARRAY[$3::text],CASE WHEN $3='watch' THEN now() END
    FROM (SELECT DISTINCT unnest($2::int[]) id) x ORDER BY id
    ON CONFLICT(season_id,dmp_id) DO UPDATE SET reasons=ARRAY(SELECT DISTINCT unnest(tracked_players.reasons||excluded.reasons) ORDER BY 1),
    last_requested_at=coalesce(excluded.last_requested_at,tracked_players.last_requested_at),active=true,
    backfill_status=CASE WHEN tracked_players.active THEN tracked_players.backfill_status ELSE 'pending' END
    WHERE NOT tracked_players.active OR NOT ($3=ANY(tracked_players.reasons)) OR
      ($3='watch' AND (tracked_players.last_requested_at IS NULL OR tracked_players.last_requested_at<now()-interval '1 hour'))`,
  [season,ids,reason]);
}
export async function track(db,season,id,reason,add=true) {
  if(add) await trackMany(db,season,[id],reason);
  else await db.query(`UPDATE tracked_players SET reasons=array_remove(reasons,$3),active=cardinality(array_remove(reasons,$3))>0
    WHERE season_id=$1 AND dmp_id=$2 AND $3=ANY(reasons)`,[season,id,reason]);
}
export async function storeSchedule(db,season,rows) {
  const unique=new Map();
  for(const row of rows) {
    if(row.eventDate<season.starts_on||row.eventDate>season.ends_on) throw new Error('Schedule row outside season');
    const key=JSON.stringify([row.eventDate.slice(0,4),row.shopId,row.eventId,row.heldId]);
    // Keep the established last-row-wins policy within one source response.
    const first=unique.get(key);
    if(first?.multiplier!=null&&row.upcoming) continue;
    unique.set(key,first?{...row,grade:first.grade,registered:first.registered||row.multiplier!=null}:{
      ...row,registered:row.multiplier!=null
    });
  }
  if(!unique.size) return [];
  const {rows:affected}=await db.query(`WITH incoming AS MATERIALIZED (
    SELECT x.*,extract(year FROM "eventDate")::int event_year FROM jsonb_to_recordset($2::jsonb) AS x(
      "eventDate" date,"shopId" int,"eventId" int,"heldId" int,name text,grade text,prefecture text,shop text,
      format text,"isTeam" boolean,multiplier numeric,approval text,upcoming boolean,registered boolean)
  ), prior_dates AS MATERIALIZED (
    SELECT e.id,e.event_date FROM events e JOIN incoming i ON
      (e.event_year,e.shop_id,e.source_event_id,e.held_id)=(i.event_year,i."shopId",i."eventId",i."heldId")
    WHERE e.season_id=$1
  ), saved AS (
    INSERT INTO events(season_id,event_year,shop_id,source_event_id,held_id,event_date,event_name,grade,prefecture,shop_name,
      format,is_team,multiplier,approval,result_status,result_registered_at,next_fetch_at)
    SELECT $1,event_year,"shopId","eventId","heldId","eventDate",name,grade,prefecture,shop,format,"isTeam",multiplier,approval,
      CASE WHEN multiplier IS NULL THEN 'unregistered' ELSE 'registered' END,
      CASE WHEN registered THEN now() END,CASE WHEN multiplier IS NOT NULL THEN now() END FROM incoming
    ORDER BY event_year,"shopId","eventId","heldId"
    ON CONFLICT(event_year,shop_id,source_event_id,held_id) DO UPDATE SET event_name=excluded.event_name,event_date=excluded.event_date,
      prefecture=excluded.prefecture,shop_name=excluded.shop_name,format=excluded.format,is_team=excluded.is_team,
      multiplier=excluded.multiplier,approval=excluded.approval,
      urgent_fetch=CASE WHEN excluded.multiplier IS NULL THEN false
        WHEN events.multiplier IS DISTINCT FROM excluded.multiplier THEN true
        ELSE events.urgent_fetch END,
      result_status=CASE WHEN excluded.multiplier IS NULL THEN 'unregistered'
        WHEN events.multiplier IS DISTINCT FROM excluded.multiplier THEN 'registered' ELSE events.result_status END,
      official_reflected_at=CASE WHEN events.multiplier IS DISTINCT FROM excluded.multiplier THEN NULL ELSE events.official_reflected_at END,
      registration_transition_at=CASE WHEN events.multiplier IS NULL AND excluded.multiplier IS NOT NULL
        THEN now() ELSE events.registration_transition_at END,
      result_registered_at=coalesce(events.result_registered_at,excluded.result_registered_at),
      next_fetch_at=CASE WHEN events.multiplier IS DISTINCT FROM excluded.multiplier THEN excluded.next_fetch_at ELSE events.next_fetch_at END
    WHERE events.season_id=excluded.season_id AND (events.multiplier IS NULL OR NOT EXISTS(
      SELECT 1 FROM incoming i WHERE (i.event_year,i."shopId",i."eventId",i."heldId")=
        (excluded.event_year,excluded.shop_id,excluded.source_event_id,excluded.held_id) AND i.upcoming))
      AND (events.event_name,events.event_date,events.prefecture,events.shop_name,events.format,events.is_team,events.multiplier,events.approval)
        IS DISTINCT FROM (excluded.event_name,excluded.event_date,excluded.prefecture,excluded.shop_name,excluded.format,excluded.is_team,excluded.multiplier,excluded.approval)
    RETURNING id,event_date
  )
  SELECT DISTINCT r.dmp_id FROM saved s JOIN prior_dates p USING(id) JOIN event_results r ON r.event_id=s.id
  WHERE s.event_date<>p.event_date`,[season.id,JSON.stringify([...unique.values()])]);
  return affected.map(row=>row.dmp_id);
}
const resultFields=['source_result_id','placement','rank_points','judge_bonus','total_points','official_counted',
  'source_updated_at','active','source','coverage','source_details'];
function resultInput(eventId,dmpId,row,source) {
  return {event_id:String(eventId),dmp_id:dmpId,source_result_id:row.resultId??null,placement:row.placement??null,
    rank_points:row.rankPoints??null,judge_bonus:row.judgeBonus??null,total_points:row.totalPoints,
    official_counted:row.officialCounted??null,source_updated_at:row.updatedAt??null,active:row.active??true,source,
    coverage:source==='event'?'api-visible':'personal',
    source_details:row.sourceDetails??Object.fromEntries(['nationalRank','prefectureRank','regionRank','judgeCount','pointId']
      .filter(key=>row[key]!=null).map(key=>[key,row[key]]))};
}
const resultColumns=['event_id','dmp_id',...resultFields];
async function saveResults(db,inputs) {
  if(!inputs.length) return [];
  const {rows}=await db.query(`WITH incoming AS MATERIALIZED (
    SELECT ${resultColumns.join(',')} FROM jsonb_populate_recordset(NULL::event_results,$1::jsonb)
  ), changes AS MATERIALIZED (
    SELECT i.event_id,i.dmp_id,jsonb_object_agg(field.key,jsonb_build_object(
      'before',coalesce(to_jsonb(old)->field.key,'null'::jsonb),'after',field.value)) diff
    FROM incoming i LEFT JOIN event_results old USING(event_id,dmp_id)
    CROSS JOIN LATERAL jsonb_each(to_jsonb(i)-ARRAY['event_id','dmp_id']) field
    WHERE NOT (i.source='personal' AND coalesce(old.source='event',false))
      AND coalesce(to_jsonb(old)->field.key,'null'::jsonb) IS DISTINCT FROM field.value
      AND NOT (old.id IS NULL AND field.key='source_details' AND field.value='{}'::jsonb)
    GROUP BY i.event_id,i.dmp_id
  ), saved AS (
    INSERT INTO event_results(${resultColumns.join(',')})
    SELECT ${resultColumns.join(',')} FROM incoming JOIN changes USING(event_id,dmp_id) ORDER BY event_id,dmp_id
    ON CONFLICT(event_id,dmp_id) DO UPDATE SET
      ${resultFields.map(field=>field+'=excluded.'+field).join(',')},updated_at=now()
    WHERE excluded.source<>'personal' OR event_results.source<>'event'
    RETURNING id,event_id,dmp_id,source_updated_at
  ), audit AS (
    INSERT INTO event_result_changes(event_result_id,changed_fields,source_updated_at)
    SELECT s.id,c.diff,s.source_updated_at FROM saved s JOIN changes c USING(event_id,dmp_id)
  )
  SELECT DISTINCT dmp_id FROM saved`,[JSON.stringify(inputs)]);
  return rows.map(row=>row.dmp_id);
}
export async function storeEvent(db,event,rows,{allowCancellation=false}={}) {
  const unique = new Map();
  for (const row of rows) {
    const old = unique.get(row.dmpId);
    if (old && JSON.stringify(old) !== JSON.stringify(row)) throw new Error('Conflicting rows for the same DMP ID');
    unique.set(row.dmpId,row);
  }
  await savePlayers(db,[...unique.values()]);
  const inputs=[...unique.values()].map(row=>resultInput(event.id,row.dmpId,row,'event'));
  if(allowCancellation) {
    const {rows:old}=await db.query(`SELECT * FROM event_results WHERE event_id=$1 AND source='event' AND active
      AND NOT(dmp_id=ANY($2::int[]))`,[event.id,[...unique.keys()]]);
    for(const row of old) inputs.push({...row,event_id:String(row.event_id),active:false});
  }
  return saveResults(db,inputs);
}
export async function findPersonalEvent(db,seasonId,row) {
  if(!row.key) return null;
  const {shopId,eventId,heldId}=row.key;
  return (await db.query(`SELECT id FROM events WHERE season_id=$1 AND event_date=$2
    AND shop_id=$3 AND source_event_id=$4 AND held_id=$5`,[seasonId,row.eventDate,shopId,eventId,heldId])).rows[0]??null;
}
const personalHistoryKey=(seasonId,player)=>'personal-history:'+seasonId+':'+player;
async function retireMissingPersonal(db,seasonId,player,eventIds) {
  const {rows:old}=await db.query(`SELECT r.* FROM event_results r JOIN events e ON e.id=r.event_id
    WHERE e.season_id=$1 AND r.dmp_id=$2 AND r.active AND r.source='personal' AND NOT(r.event_id=ANY($3::bigint[]))`,
  [seasonId,player,eventIds]);
  await saveResults(db,old.map(r=>resultInput(r.event_id,player,{placement:r.placement,totalPoints:r.total_points,
    officialCounted:r.official_counted,active:false},'personal')));
}
export async function storePersonal(db,season,player,rows) {
  await db.query('DELETE FROM pending_personal_results WHERE season_id=$1 AND dmp_id=$2',[season.id,player]);
  const {rows:matches}=await db.query(`SELECT x.ordinality::int AS position,e.id
    FROM jsonb_array_elements($2::jsonb) WITH ORDINALITY AS x(data,ordinality)
    JOIN events e ON e.season_id=$1 AND e.event_date=(x.data->>'eventDate')::date
      AND e.shop_id=(x.data->'key'->>'shopId')::int AND e.source_event_id=(x.data->'key'->>'eventId')::int
      AND e.held_id=(x.data->'key'->>'heldId')::int`,[season.id,JSON.stringify(rows)]);
  const byPosition=new Map(matches.map(row=>[row.position-1,row.id]));
  const matched=new Map();
  const unresolved=[];
  let pending=0;
  for(const [position,row] of rows.entries()) {
    const eventId=byPosition.get(position);
    if(eventId===undefined) {
      const ids=row.key?[row.key.shopId,row.key.eventId,row.key.heldId]:[];
      const identity=JSON.stringify([row.eventDate,...ids,row.name,row.placement,row.totalPoints]);
      unresolved.push({identity,data:row});
      if(row.totalPoints>0) pending++;
      continue;
    }
    if(matched.has(eventId)&&JSON.stringify(matched.get(eventId))!==JSON.stringify(row)) throw new Error('Conflicting personal results');
    matched.set(eventId,row);
  }
  if(unresolved.length) await db.query(`INSERT INTO pending_personal_results
    SELECT $1,$2,identity,data FROM jsonb_to_recordset($3::jsonb) AS x(identity text,data jsonb)
    ON CONFLICT DO NOTHING`,[season.id,player,JSON.stringify(unresolved)]);
  await saveResults(db,[...matched].map(([event,row])=>resultInput(event,player,row,'personal')));
  const historyKey=personalHistoryKey(season.id,player);
  if (pending) await setSetting(db,historyKey,[...matched.keys()].map(String));
  else {
    await retireMissingPersonal(db,season.id,player,[...matched.keys()]);
    await db.query('DELETE FROM app_settings WHERE key=$1',[historyKey]);
  }
  await db.query(`UPDATE tracked_players SET backfill_status=CASE WHEN $3::integer=0 THEN 'ready'
    WHEN backfill_status IN ('ready','stale') THEN 'stale' ELSE 'partial' END WHERE season_id=$1 AND dmp_id=$2`,[season.id,player,pending]);
  return pending;
}
export async function storeOfficial(db,season,snapshot) {
  const {rows:[latest]} = await db.query('SELECT max(aggregation_at) AS time FROM official_rankings WHERE season_id=$1',[season.id]);
  if (latest.time && new Date(latest.time) >= new Date(snapshot.time)) return false;
  await db.query('DELETE FROM official_rankings WHERE season_id=$1',[season.id]);
  await db.query(`UPDATE tracked_players SET reasons=array_remove(reasons,'official'), active=cardinality(array_remove(reasons,'official'))>0
    WHERE season_id=$1 AND 'official'=ANY(reasons) AND NOT(dmp_id=ANY($2::int[]))`,[season.id,snapshot.rows.filter(r=>r.rank<=200).map(r=>r.dmpId)]);
  await savePlayers(db,snapshot.rows);
  await db.query(`WITH incoming AS (
    SELECT "dmpId",rank,points,jsonb_build_object('name',name,'prefecture',prefecture,'region',region,
      'prefectureRank',"prefectureRank",'regionRank',"regionRank") details
    FROM jsonb_to_recordset($3::jsonb) AS x("dmpId" int,rank int,points int,name text,prefecture text,region text,
      "prefectureRank" int,"regionRank" int)
  ), latest AS (
    INSERT INTO official_rankings(season_id,dmp_id,rank,points,aggregation_at,source_details)
    SELECT $1,"dmpId",rank,points,$2,details FROM incoming
  ), history AS (
    INSERT INTO official_history(season_id,dmp_id,rank,points,aggregation_at,source_details)
    SELECT $1,"dmpId",rank,points,$2,details FROM incoming
  )
  INSERT INTO tracked_players(season_id,dmp_id,reasons)
  SELECT $1,"dmpId",ARRAY['official'] FROM incoming WHERE rank<=200 ORDER BY "dmpId"
  ON CONFLICT(season_id,dmp_id) DO UPDATE SET reasons=ARRAY(SELECT DISTINCT unnest(tracked_players.reasons||excluded.reasons) ORDER BY 1),
    active=true,backfill_status=CASE WHEN tracked_players.active THEN tracked_players.backfill_status ELSE 'pending' END
  WHERE NOT tracked_players.active OR NOT ('official'=ANY(tracked_players.reasons))`,
  [season.id,snapshot.time,JSON.stringify(snapshot.rows)]);
  return true;
}

export async function recalculateWeeks(db,seasonId,ids=null,affectedDate=null) {
  const {rows:[rule]} = await db.query('SELECT * FROM aggregation_rules WHERE season_id=$1 ORDER BY version DESC LIMIT 1',[seasonId]);
  if (!rule) throw new Error('No season rule');
  const scope = [seasonId,ids,rule.grade_rules,rule.weekly_limit,rule.version,affectedDate];
  if(!ids||ids.length) await db.query(`WITH candidates AS (
    SELECT r.id,r.dmp_id,date_trunc('week',e.event_date::timestamp)::date week_start,r.total_points,
      $3::jsonb->>e.grade mode,r.active,
      row_number() OVER(PARTITION BY r.dmp_id,date_trunc('week',e.event_date::timestamp),$3::jsonb->>e.grade,r.active
        ORDER BY r.total_points DESC,e.event_year,e.shop_id,e.source_event_id,e.held_id) sequence
    FROM event_results r JOIN events e ON e.id=r.event_id
    WHERE e.season_id=$1 AND ($2::int[] IS NULL OR r.dmp_id=ANY($2))
      AND ($6::date IS NULL OR date_trunc('week',e.event_date::timestamp)=date_trunc('week',$6::date::timestamp))
  ), chosen AS (
    SELECT *,coalesce(active AND total_points>0 AND (mode='extra' OR (mode='weekly' AND sequence<=$4)),false) used
    FROM candidates
  ), result_flags AS (
    UPDATE event_results r SET provisional_counted=c.used FROM chosen c WHERE r.id=c.id AND r.provisional_counted<>c.used
  ), weeks AS (
    SELECT dmp_id,week_start,
      coalesce(sum(total_points) FILTER(WHERE used AND mode='weekly'),0)::int weekly,
      coalesce(sum(total_points) FILTER(WHERE used AND mode='extra'),0)::int extra,
      coalesce(sum(total_points) FILTER(WHERE used),0)::int total
    FROM chosen GROUP BY dmp_id,week_start
  ), prune AS (
    DELETE FROM weekly_points w WHERE season_id=$1 AND ($2 IS NULL OR w.dmp_id=ANY($2))
      AND ($6 IS NULL OR w.week_start=date_trunc('week',$6::date::timestamp)::date)
      AND NOT EXISTS(SELECT 1 FROM weeks p WHERE p.dmp_id=w.dmp_id AND p.week_start=w.week_start)
  )
  INSERT INTO weekly_points SELECT $1,dmp_id,week_start,weekly,extra,total,$5 FROM weeks
  ON CONFLICT(season_id,dmp_id,week_start) DO UPDATE SET weekly_counted_points=excluded.weekly_counted_points,
    extra_points=excluded.extra_points,total_points=excluded.total_points,rule_version=excluded.rule_version
  WHERE (weekly_points.weekly_counted_points,weekly_points.extra_points,weekly_points.total_points,weekly_points.rule_version)
    IS DISTINCT FROM (excluded.weekly_counted_points,excluded.extra_points,excluded.total_points,excluded.rule_version)`,scope);
  return rule;
}
export async function recalculate(db,seasonId,ids=null,affectedDate=null) {
  await recalculateWeeks(db,seasonId,ids,affectedDate);
  await db.query(`WITH eligible AS MATERIALIZED (
    SELECT t.dmp_id,t.backfill_status FROM tracked_players t
    WHERE t.season_id=$1 AND t.active AND t.backfill_status IN ('ready','stale')
  ), pruned AS (
    DELETE FROM provisional_rankings r WHERE season_id=$1 AND NOT EXISTS(
      SELECT 1 FROM eligible t WHERE t.dmp_id=r.dmp_id)
  )
  INSERT INTO provisional_rankings(season_id,dmp_id,rank,points,coverage,status,calculated_at)
    SELECT $1,t.dmp_id,rank() OVER(ORDER BY coalesce(p.points,0) DESC),coalesce(p.points,0),
      'tracked-only',t.backfill_status,now() FROM eligible t
      LEFT JOIN (SELECT dmp_id,sum(total_points) points FROM weekly_points WHERE season_id=$1 GROUP BY dmp_id) p USING(dmp_id)
    ON CONFLICT(season_id,dmp_id) DO UPDATE SET rank=excluded.rank,points=excluded.points,status=excluded.status,calculated_at=excluded.calculated_at
    WHERE (provisional_rankings.rank,provisional_rankings.points,provisional_rankings.status) IS DISTINCT FROM
      (excluded.rank,excluded.points,excluded.status)`,[seasonId]);
  await db.query(`WITH previous AS (
    SELECT DISTINCT ON(dmp_id) dmp_id,rank,points,tracked,status FROM provisional_history
    WHERE season_id=$1 ORDER BY dmp_id,observed_at DESC,id DESC
  ), changed AS (
    SELECT t.dmp_id,r.rank,r.points,t.active tracked,t.backfill_status status
    FROM tracked_players t LEFT JOIN provisional_rankings r USING(season_id,dmp_id) LEFT JOIN previous p USING(dmp_id)
    WHERE t.season_id=$1 AND (r.rank,r.points,t.active,t.backfill_status) IS DISTINCT FROM (p.rank,p.points,p.tracked,p.status)
  ), batch AS (
    INSERT INTO aggregation_batches(season_id) SELECT $1 WHERE EXISTS(SELECT 1 FROM changed) RETURNING id,observed_at
  )
  INSERT INTO provisional_history(season_id,dmp_id,rank,points,tracked,status,batch_id,observed_at)
    SELECT $1,dmp_id,rank,points,tracked,status,batch.id,batch.observed_at FROM changed CROSS JOIN batch`,[seasonId]);
  await db.query(`UPDATE seasons s SET initialized_at=now() WHERE s.id=$1 AND s.initialized_at IS NULL
    AND EXISTS (SELECT 1 FROM season_initial_data_ready v WHERE v.id=s.id)`,[seasonId]);
}
export async function borderAt(db,season,position,time) {
  const {rows:[row]} = await db.query(`WITH state AS (
    SELECT DISTINCT ON(dmp_id) dmp_id,points,tracked FROM provisional_history
    WHERE season_id=$1 AND observed_at<=$3 ORDER BY dmp_id,observed_at DESC,id DESC
  ) SELECT points FROM state WHERE tracked AND points IS NOT NULL ORDER BY points DESC,dmp_id OFFSET $2 LIMIT 1`,[season,position-1,time]);
  return row?.points ?? null;
}
export async function compactHistory(db,season) {
  const {rows:[eligible]}=await db.query(`SELECT s.id FROM seasons s WHERE s.id=$1 AND s.compacted_at IS NULL AND
    s.finalized_at<=now()-interval '30 days' AND EXISTS(SELECT 1 FROM backup_history WHERE verified_at>=s.finalized_at AND status='verified')`,[season]);
  if (!eligible) return false;
  await db.query(`WITH days AS (
    SELECT DISTINCT (observed_at AT TIME ZONE 'Asia/Tokyo')::date AS day FROM provisional_history WHERE season_id=$1 AND day IS NULL
  ), last_state AS (
    SELECT d.day,h.* FROM days d CROSS JOIN LATERAL (
      SELECT DISTINCT ON(dmp_id) dmp_id,rank,points,tracked,status FROM provisional_history
      WHERE season_id=$1 AND observed_at<((d.day+1)::timestamp AT TIME ZONE 'Asia/Tokyo')
      ORDER BY dmp_id,observed_at DESC,id DESC
    ) h
  ), extremes AS (
    SELECT (observed_at AT TIME ZONE 'Asia/Tokyo')::date AS day,dmp_id,min(rank) best,max(rank) worst
    FROM provisional_history WHERE season_id=$1 GROUP BY 1,2
  ), opening AS (
    SELECT d.day,h.dmp_id,h.rank FROM days d CROSS JOIN LATERAL (
      SELECT DISTINCT ON(dmp_id) dmp_id,rank FROM provisional_history
      WHERE season_id=$1 AND observed_at<(d.day::timestamp AT TIME ZONE 'Asia/Tokyo') ORDER BY dmp_id,observed_at DESC,id DESC
    ) h
  )
  INSERT INTO provisional_history(season_id,dmp_id,rank,points,tracked,status,observed_at,day,best_rank,worst_rank)
  SELECT $1,s.dmp_id,s.rank,s.points,s.tracked,s.status,((s.day+1)::timestamp AT TIME ZONE 'Asia/Tokyo')-interval '1 microsecond',
    s.day,least(s.rank,e.best,o.rank),greatest(s.rank,e.worst,o.rank)
  FROM last_state s LEFT JOIN extremes e USING(day,dmp_id) LEFT JOIN opening o USING(day,dmp_id)`,[season]);
  await db.query('DELETE FROM provisional_history WHERE season_id=$1 AND day IS NULL',[season]);
  await db.query('DELETE FROM aggregation_batches WHERE season_id=$1',[season]);
  await db.query('UPDATE seasons SET compacted_at=now() WHERE id=$1',[season]);
  return true;
}

// The caller holds the season lock. Move only resolved rows and leave conflicting
// rows available for investigation, without treating this subset as a full history.
export async function replayPendingPersonal(db,seasonId) {
  const {rows}=await db.query(`SELECT p.dmp_id,p.event_key,p.data,e.id event_id
    FROM pending_personal_results p JOIN events e ON e.season_id=p.season_id
      AND e.event_date=(p.data->>'eventDate')::date AND e.shop_id=(p.data->'key'->>'shopId')::int
      AND e.source_event_id=(p.data->'key'->>'eventId')::int AND e.held_id=(p.data->'key'->>'heldId')::int
    WHERE p.season_id=$1 ORDER BY p.dmp_id,e.id,p.event_key`,[seasonId]);
  const groups=Map.groupBy(rows,row=>row.dmp_id+':'+row.event_id);
  const affected=new Map();
  const resolved=[];
  const inputs=[];
  for(const group of groups.values()) {
    const first=group[0];
    const signature=data=>JSON.stringify([data.placement,data.totalPoints,data.officialCounted]);
    if(group.some(row=>signature(row.data)!==signature(first.data))) continue;
    inputs.push(resultInput(first.event_id,first.dmp_id,first.data,'personal'));
    for(const row of group) resolved.push({dmp_id:row.dmp_id,event_key:row.event_key});
    if(!affected.has(first.dmp_id)) affected.set(first.dmp_id,[]);
    affected.get(first.dmp_id).push(String(first.event_id));
  }
  if(!affected.size) return [];
  await saveResults(db,inputs);
  await db.query(`DELETE FROM pending_personal_results p USING jsonb_to_recordset($2::jsonb) AS x(dmp_id int,event_key text)
    WHERE p.season_id=$1 AND p.dmp_id=x.dmp_id AND p.event_key=x.event_key`,[seasonId,JSON.stringify(resolved)]);
  const {rows:completed}=await db.query(`UPDATE tracked_players t SET backfill_status='ready'
    WHERE t.season_id=$1 AND t.dmp_id=ANY($2::int[]) AND t.active
      AND NOT EXISTS(SELECT 1 FROM pending_personal_results p WHERE p.season_id=t.season_id AND p.dmp_id=t.dmp_id
        AND (p.data->>'totalPoints')::int>0)
      AND NOT EXISTS(SELECT 1 FROM fetch_jobs j WHERE j.type='personal' AND j.payload->>'season'=t.season_id::text
        AND j.payload->>'id'=t.dmp_id::text AND j.status<>'done' AND j.last_error IS NOT NULL) RETURNING dmp_id`,[seasonId,[...affected.keys()]]);
  const ready=new Set(completed.map(row=>row.dmp_id));
  const {rows:histories}=await db.query(`SELECT key,value FROM app_settings WHERE key=ANY($1::text[])`,
    [[...affected.keys()].map(player=>personalHistoryKey(seasonId,player))]);
  const history=new Map(histories.map(row=>[row.key,row.value]));
  const retire=[];
  const updates=[];
  for(const [player,eventIds] of affected) {
    const key=personalHistoryKey(seasonId,player);
    if(!history.has(key)) continue;
    const captured=[...new Set([...history.get(key),...eventIds])];
    if(ready.has(player)) retire.push({key,player,captured});
    else updates.push({key,value:captured});
  }
  if(retire.length) {
    const {rows:missing}=await db.query(`SELECT r.* FROM jsonb_to_recordset($2::jsonb) AS x(player int,captured jsonb)
      JOIN event_results r ON r.dmp_id=x.player JOIN events e ON e.id=r.event_id
      WHERE e.season_id=$1 AND r.active AND r.source='personal' AND NOT (x.captured ? r.event_id::text)`,[seasonId,JSON.stringify(retire)]);
    await saveResults(db,missing.map(r=>resultInput(r.event_id,r.dmp_id,{placement:r.placement,totalPoints:r.total_points,
      officialCounted:r.official_counted,active:false},'personal')));
    await db.query('DELETE FROM app_settings WHERE key=ANY($1::text[])',[retire.map(row=>row.key)]);
  }
  if(updates.length) await db.query(`UPDATE app_settings s SET value=x.value,updated_at=now()
    FROM jsonb_to_recordset($1::jsonb) AS x(key text,value jsonb) WHERE s.key=x.key AND s.value IS DISTINCT FROM x.value`,
  [JSON.stringify(updates)]);
  return [...affected.keys()];
}
