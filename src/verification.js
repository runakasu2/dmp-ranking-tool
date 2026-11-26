import {grades} from './dmp.js';
import {findPersonalEvent,recalculateWeeks,storePersonal,storeSchedule,track} from './ranking.js';

export const verificationKey=(season,player)=>'verification:'+season+':'+player;

function key(row) {
  return JSON.stringify([row.eventDate,row.shopId,row.eventId,row.heldId]);
}

export async function collectVerificationEvents(db,client,season,rows,mapping,renew) {
  const missing=new Map();
  for(const row of rows) {
    if(!row.key||await findPersonalEvent(db,season.id,row)) continue;
    const date=row.eventDate;
    if(!missing.has(date)) missing.set(date,new Set());
    missing.get(date).add(key({...row.key,eventDate:date}));
  }
  const events=[];
  for(const [date,keys] of missing) {
    for(const grade of grades) {
      await renew();
      const rows=await client.schedule(grade,date,date,'Result',mapping);
      for(const row of rows) if(keys.delete(key(row))) events.push(row);
      if(!keys.size) break;
    }
  }
  return events;
}

export async function calculateVerification(db,season,player,rows,events) {
  // Reuse the production merge and scoring rules in a scratch savepoint.
  // Only the report is persisted by the caller.
  await db.query('SAVEPOINT player_verification');
  try {
    await storeSchedule(db,season,events);
    const matched=[];
    for(const row of rows) {
      const event=await findPersonalEvent(db,season.id,row);
      if(event) matched.push(event.id);
    }
    await db.query(`UPDATE event_results r SET active=false FROM events e WHERE r.event_id=e.id
      AND e.season_id=$1 AND r.dmp_id=$2 AND r.active AND NOT(e.id=ANY($3::bigint[]))`,[season.id,player.dmp_id,matched]);
    await track(db,season.id,player.dmp_id,'admin');
    await storePersonal(db,season,player.dmp_id,rows);
    const rule=await recalculateWeeks(db,season.id,[player.dmp_id]);
    const ids=[season.id,player.dmp_id];
    const {rows:weekly}=await db.query(`SELECT week_start::text,weekly_counted_points,extra_points,total_points
      FROM weekly_points WHERE season_id=$1 AND dmp_id=$2 ORDER BY week_start`,ids);
    const {rows:results}=await db.query(`SELECT e.event_date::text,e.event_name,e.grade,r.total_points,r.provisional_counted
      FROM event_results r JOIN events e ON e.id=r.event_id WHERE e.season_id=$1 AND r.dmp_id=$2 AND r.active
      ORDER BY e.event_date,e.id`,ids);
    const {rows:unmatched}=await db.query('SELECT data FROM pending_personal_results WHERE season_id=$1 AND dmp_id=$2 ORDER BY event_key',ids);
    const {rows:[official]}=await db.query('SELECT points,aggregation_at FROM official_rankings WHERE season_id=$1 AND dmp_id=$2',ids);
    const total=weekly.reduce((sum,row)=>sum+row.total_points,0);
    return {weekly,results,unmatched:unmatched.map(row=>row.data),total,official:official??null,
      difference:official?total-official.points:null,weeklyLimit:rule.weekly_limit,checkedAt:new Date().toISOString()};
  } finally {
    await db.query('ROLLBACK TO SAVEPOINT player_verification');
    await db.query('RELEASE SAVEPOINT player_verification');
  }
}
