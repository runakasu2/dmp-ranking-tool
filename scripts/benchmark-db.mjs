import {PGlite} from '@electric-sql/pglite';
import {performance} from 'node:perf_hooks';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';

const root=pathToFileURL(resolve(process.argv[2]??'.')+'/');
const {migrate}=await import(new URL('src/db.js',root));
const {claim,enqueue,runJob}=await import(new URL('src/jobs.js',root));
const db=new PGlite();
let calls=0;
const query=(...args)=>{calls++;return db.query(...args);};
const pool={query,connect:async()=>({query,release(){}})};
async function report(label,start,jobId){
  const result={label,queries:calls,milliseconds:Math.round(performance.now()-start)};
  const {rows:[log]}=await db.query(`SELECT to_jsonb(fetch_logs)->'phase_ms' phases FROM fetch_logs
    WHERE job_id=$1 ORDER BY id DESC LIMIT 1`,[jobId]);
  console.log(JSON.stringify({...result,phases:log?.phases??null}));
}
try{
  await db.transaction(migrate);
  const {rows:[season]}=await db.query(`INSERT INTO seasons(source_term,legacy_term,starts_on,ends_on)
    VALUES('N','O','2020-01-01','2020-12-31') RETURNING id`);
  await db.query(`INSERT INTO aggregation_rules(season_id,version,weekly_limit,grade_rules) VALUES($1,1,2,'{"CS":"weekly","GP":"extra"}')`,[season.id]);
  const rankings=Array.from({length:1004},(_,i)=>({dmpId:i+1,rank:i+1,points:1004-i,name:'Player '+(i+1)}));
  await enqueue(db,'official-only',{season:season.id},'official:bench',0);
  let job=await claim(db);
  calls=0;
  let start=performance.now();
  await runJob(pool,job,{client:{official:async()=>({time:'2020-02-01T00:00:00.000Z',rows:rankings})}});
  await report('official-1004',start,job.id);
  if((await db.query('SELECT count(*)::int n FROM official_rankings')).rows[0].n!==1004) throw new Error('Official benchmark failed');
  const events=Array.from({length:129},(_,i)=>({eventDate:'2020-01-03',shopId:1,eventId:i+1,heldId:1,name:'Event '+i,grade:'CS',multiplier:'1',isTeam:false}));
  const pending=Array.from({length:636},(_,i)=>{
    const eventId=i%129+1;
    return {player:i%200+1,key:String(i),data:{eventDate:'2020-01-03',name:'Event '+(eventId-1),key:{shopId:1,eventId,heldId:1},placement:1,totalPoints:10}};
  });
  await db.query(`INSERT INTO pending_personal_results SELECT $1,x.player,x.key,x.data FROM jsonb_to_recordset($2::jsonb)
    AS x(player int,key text,data jsonb)`,[season.id,JSON.stringify(pending)]);
  // Leave every player partial, as on the first real batch, while exercising official comparison.
  await db.query(`UPDATE tracked_players SET backfill_status='partial'`);
  await db.query(`INSERT INTO pending_personal_results SELECT season_id,dmp_id,'unmatched','{"eventDate":"2020-01-08","totalPoints":1}'::jsonb
    FROM tracked_players`);
  await enqueue(db,'complete-schedule',{season:season.id,grade:'CS',from:'2020-01-01',to:'2020-01-05'},'complete:bench',0);
  job=await claim(db);
  calls=0;
  start=performance.now();
  await runJob(pool,job,{client:{schedule:async()=>events}});
  await report('schedule-129-replay-636',start,job.id);
  const {rows:[check]}=await db.query(`SELECT (SELECT count(*)::int FROM events) events,
    (SELECT count(*)::int FROM event_results) results,
    (SELECT count(*)::int FROM event_result_changes) history,
    (SELECT count(*)::int FROM pending_personal_results) pending`);
  if(check.events!==129||check.results!==636||check.history!==636||check.pending!==200) throw new Error(JSON.stringify(check));
} finally {await db.close();}
