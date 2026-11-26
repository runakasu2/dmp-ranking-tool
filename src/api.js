import {candidatePreview,heldResultReview,queueMigration,queueReview,usage} from './acquisition.js';
import {cronStatus,recordCronReceipt} from './cron-status.js';
import {displayName} from './handle-name.js';
import express from 'express';
import {createHash,randomBytes,scryptSync,timingSafeEqual} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {date,grades,int} from './dmp.js';
import {transaction} from './db.js';
import {enqueue,enqueueCandidatePreview,enqueueCompletion,enqueueOfficial,enqueuePersonalBatch,jst,schedule,slots} from './jobs.js';
import {recalculate,seasonLock,setting,setSetting,track,trackMany} from './ranking.js';

import {completionProgress} from './completion.js';
import {verificationKey} from './verification.js';

const hash=value=>createHash('sha256').update(value).digest('hex');
const equal=(a,b)=>timingSafeEqual(Buffer.from(hash(a)),Buffer.from(hash(b)));
const fail=(status,message)=>Object.assign(new Error(message),{status});
const jday=()=>jst().slice(0,10);
const secretHash=(password,salt)=>scryptSync(password,salt,64).toString('hex');
export async function bootstrap(db,login,password) {
  if(!login||!password) return;
  if(password.length<12||password.length>200) throw new Error('ADMIN_PASSWORD needs 12–200 characters');
  const salt=randomBytes(16).toString('hex');
  await db.query(`INSERT INTO admin_accounts(login,password_hash,role) VALUES($1,$2,'admin') ON CONFLICT(login) DO NOTHING`,
    [login,salt+':'+secretHash(password,salt)]);
}
const withDisplayName=row=>({...row,display_name:displayName(row.handle_name)});
async function encodedNameMatches(db,query,exact=false) {
  if(!query) return [];
  const {rows}=await db.query("SELECT dmp_id,handle_name FROM players WHERE strpos(handle_name,'&#')>0");
  const needle=displayName(query).toLowerCase();
  return rows.filter(row=>{
    const name=displayName(row.handle_name).trim().toLowerCase();
    return exact?name===needle:name.includes(needle);
  }).map(row=>row.dmp_id);
}
function id(value) {
  if(!/^\d{1,19}$/.test(String(value))||BigInt(value)<=0n||BigInt(value)>9223372036854775807n) throw fail(400,'IDが無効です');
  return String(value);
}
const playerId=value=>int(value,1);
const bounded=(value,max)=>Math.min(max,int(value,1));
const readPool=(pool,cache)=>async(req,res,next)=>{
  const version=await versionOf(pool);
  const key=version+':'+req.originalUrl;
  if(cache.size>120) cache.clear();
  const found=cache.get(key);
  res.set('Cache-Control','public, max-age=15, must-revalidate');
  if(found&&found.until>Date.now()) return res.json(found.data);
  const json=res.json.bind(res);
  res.json=data=>{
    if(res.statusCode===200) cache.set(key,{until:Date.now()+30000,data});
    return json(data);
  };
  next();
};
async function versionOf(db) {
  const {rows:[row]}=await db.query(`SELECT greatest(
    coalesce((SELECT max(id) FROM fetch_logs),0),0)::text AS jobs,
    coalesce((SELECT max(id) FROM provisional_history),0)::text AS history,
    coalesce((SELECT max(updated_at)::text FROM app_settings WHERE key<>'dmp_next_request'),'') AS settings,
    (SELECT count(*)::text||':'||coalesce(max(initialized_at)::text,'') FROM seasons) AS seasons`);
  return Object.values(row).join('|');
}
async function selectSeason(db,value) {
  const {rows:[season]}=await db.query(`SELECT *,starts_on::text,ends_on::text FROM seasons s
    WHERE ($1::bigint IS NULL OR id=$1) ORDER BY (s.starts_on<=$2::date) DESC, s.starts_on DESC LIMIT 1`,[value?id(value):null,jday()]);
  return season;
}
async function jobActivity(db) {
  const [jobs,logs]=await Promise.all([
    db.query(`SELECT j.id,j.type,j.status,j.attempts,j.next_run_at,j.last_error,j.started_at,j.finished_at,j.priority,j.reason,j.legacy_queue,j.payload AS target,j.payload->>'season' AS season_id,
      CASE WHEN j.status='running' AND j.started_at IS NOT NULL THEN coalesce(p.phase,'prepare') END phase,
      CASE WHEN j.status='running' THEN p.phase_started_at END phase_started_at,
      extract(epoch FROM (CASE WHEN j.status='running' THEN clock_timestamp() ELSE j.finished_at END-j.started_at))*1000 AS elapsed_ms
      FROM fetch_jobs j LEFT JOIN fetch_job_progress p ON p.job_id=j.id AND p.lease_token=j.lease_token ORDER BY j.id DESC LIMIT 50`),
    db.query('SELECT * FROM fetch_logs ORDER BY id DESC LIMIT 50')
  ]);
  return {jobs:jobs.rows,logs:logs.rows};
}
export function createApp(pool,{cronSecret=process.env.CRON_SECRET,worker,secure=process.env.NODE_ENV==='production'}={}) {
  const app=express();
  app.disable('x-powered-by');
  if(secure) app.set('trust proxy',1);
  const limits=new Map();
  const cache=new Map();
  const limit=(name,max)=>(req,res,next)=>{
    const now=Date.now();
    if(limits.size>2000) for(const [key,entry] of limits) if(entry.until<now) limits.delete(key);
    const key=name+':'+req.ip;
    let entry=limits.get(key);
    if(!entry||entry.until<now) {
      if(limits.size>4000) return next(fail(429,'アクセス上限です'));
      limits.set(key,entry={until:now+60000,count:0});
    }
    if(++entry.count>max) return next(fail(429,'アクセス上限です'));
    next();
  };
  function browserOnly(req,res,next) {
    if(req.get('x-dmp-request')!=='1'||(req.get('sec-fetch-site')&&req.get('sec-fetch-site')!=='same-origin')) return next(fail(403,'リクエストを拒否しました'));
    next();
  }
  async function authenticated(req,res,next) {
    const token=req.headers.cookie?.match(/(?:^|; )dmp_session=([a-f0-9]{64})(?:;|$)/)?.[1];
    if(!token) throw fail(401,'管理者認証が必要です');
    const {rows:[session]}=await pool.query(`SELECT s.session_hash FROM admin_sessions s JOIN admin_accounts a ON a.id=s.admin_id
      WHERE session_hash=$1 AND expires_at>now() AND role='admin'`,[hash(token)]);
    if(!session) throw fail(401,'管理者認証が必要です');
    req.adminSession=session.session_hash;
    next();
  }
  app.use((req,res,next)=>{
    res.set({'X-Robots-Tag':'noindex, nofollow','X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer',
      'Content-Security-Policy':"default-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'"});
    next();
  });
  app.use(express.json({limit:'32kb'}));
  app.post('/internal/cron',limit('cron',30),async(req,res)=>{
    const received=req.get('x-cron-secret');
    if(!cronSecret||!received||!equal(cronSecret,received)) throw fail(401,'cron認証が必要です');
    const receivedAt=new Date();
    let next;
    try {
      next=await transaction(pool,async db=>{
        const scheduled=await schedule(db,receivedAt);
        await recordCronReceipt(db,receivedAt,'ok');
        return scheduled;
      });
    } catch(error) {
      await recordCronReceipt(pool,receivedAt,'failed').catch(()=>{});
      throw error;
    }
    res.status(202).json({next});
    worker?.kick().catch(()=>console.error('Worker cycle failed'));
  });
  app.get('/health',(_,res)=>res.json({ok:true}));
  app.use('/api',limit('api',150));
  app.get('/api/version',async(_,res)=>res.set('Cache-Control','no-store').json({version:await versionOf(pool)}));
  const read=readPool(pool,cache);
  app.get('/api/seasons',read,async(_,res)=>res.json((await pool.query(`SELECT id,source_term,starts_on::text,ends_on::text,finalized_at,initialized_at FROM seasons s ORDER BY s.starts_on DESC`)).rows));
  app.get('/api/state',read,async(req,res)=>{
    const season=await selectSeason(pool,req.query.season);
    if(!season) return res.json({season:null});
    const {rows:[counts]}=await pool.query(`WITH held AS (
      SELECT e.id,e.multiplier,e.official_reflected_at,e.last_fetched_at
      FROM events e WHERE e.season_id=$1 AND e.event_date<=$2
    ), personal AS (
      SELECT DISTINCT r.event_id FROM event_results r JOIN held h ON h.id=r.event_id
      WHERE r.active AND r.source='personal'
    )
    SELECT count(*) FILTER(WHERE h.multiplier IS NOT NULL)::int registered,
      count(*) FILTER(WHERE h.multiplier IS NULL)::int unregistered,
      count(p.event_id)::int personal_saved,
      count(*) FILTER(WHERE h.last_fetched_at IS NOT NULL)::int event_api_fetched,
      count(*) FILTER(WHERE h.official_reflected_at IS NOT NULL)::int reflected,
      count(*) FILTER(WHERE h.official_reflected_at IS NULL AND h.multiplier IS NOT NULL)::int reflection_unconfirmed
    FROM held h LEFT JOIN personal p ON p.event_id=h.id`,[season.id,jday()]);
    const {rows:[progress]}=await pool.query(`SELECT count(*) FILTER(WHERE 'official'=ANY(reasons))::int total,
      count(*) FILTER(WHERE 'official'=ANY(reasons) AND backfill_status='ready')::int ready,
      count(*) FILTER(WHERE active AND backfill_status<>'ready')::int incomplete FROM tracked_players WHERE season_id=$1`,[season.id]);
    const {rows:[times]}=await pool.query(`SELECT (SELECT max(aggregation_at) FROM official_rankings WHERE season_id=$1) official,
      (SELECT max(calculated_at) FROM provisional_rankings WHERE season_id=$1) provisional,
      (SELECT count(*)::int FROM fetch_jobs WHERE payload->>'season'=$1::text AND last_error IS NOT NULL AND status<>'done') failures`,[season.id]);
    const [config,paused,receipt]=await Promise.all([
      setting(pool,'schedule',{}),setting(pool,'paused',false),setting(pool,'cron_receipt')
    ]);
    const now=new Date();
    res.json({season,counts,progress,times,next:slots(now,config).next,paused,cron:cronStatus(receipt,paused,now)});

  });
  app.get('/api/rankings',read,async(req,res)=>{
    const season=await selectSeason(pool,req.query.season);
    if(!season) return res.json([]);
    const mode=req.query.mode==='official'?'official':'provisional';
    const watch=req.query.ids?String(req.query.ids).split(',').slice(0,30).map(playerId):null;
    const count=[50,100,200].includes(Number(req.query.limit))?Number(req.query.limit):req.query.limit==='all'?null:100;
    const q=String(req.query.q??'').slice(0,100).toLowerCase();
    const encoded=await encodedNameMatches(pool,q);
    const columns={rank:'rank',name:'handle_name',points:'points',official_rank:'official_rank',official_points:'official_points',
      rank_diff:'rank_diff',point_diff:'point_diff',weekly:'weekly',status:'status'};
    const sort=Object.hasOwn(columns,req.query.sort)?columns[req.query.sort]:'rank';
    const direction=req.query.dir==='desc'?'DESC':'ASC';
    const {rows}=await pool.query(`WITH list AS (
      SELECT p.dmp_id,p.handle_name,o.rank official_rank,o.points official_points,
      CASE WHEN $3 THEN r.rank END provisional_rank,CASE WHEN $3 THEN r.points END provisional_points,
      ${mode==='official'?'o.rank':'CASE WHEN $3 THEN r.rank END'} rank,
      ${mode==='official'?'o.points':'CASE WHEN $3 THEN r.points END'} points,
      CASE WHEN $3 THEN o.rank-r.rank END rank_diff,CASE WHEN $3 THEN r.points-o.points END point_diff,
      CASE WHEN $3 AND r.rank IS NOT NULL THEN w.total_points END weekly,t.backfill_status status
      FROM players p LEFT JOIN official_rankings o ON o.dmp_id=p.dmp_id AND o.season_id=$1
      LEFT JOIN tracked_players t ON t.dmp_id=p.dmp_id AND t.season_id=$1
      LEFT JOIN provisional_rankings r ON r.dmp_id=p.dmp_id AND r.season_id=$1
        AND t.active AND t.backfill_status IN ('ready','stale') AND r.status IN ('ready','stale')
      LEFT JOIN weekly_points w ON w.dmp_id=p.dmp_id AND w.season_id=$1 AND w.week_start=date_trunc('week',$6::date::timestamp)::date
      WHERE (($4::int[] IS NOT NULL AND p.dmp_id=ANY($4)) OR ($4 IS NULL AND
       ((CASE WHEN $7 THEN o.rank IS NOT NULL ELSE $3 AND r.rank IS NOT NULL END) OR ($2<>'' AND o.rank IS NOT NULL))))
        AND ($2='' OR strpos(lower(p.handle_name),$2)>0 OR p.dmp_id::text=$2 OR p.dmp_id=ANY($8::int[]))
    ), ordered AS (
      SELECT *,row_number() OVER(ORDER BY ${sort} ${direction} NULLS LAST,official_rank NULLS LAST,dmp_id) position FROM list
    )
    SELECT * FROM ordered WHERE $5::int IS NULL OR $2<>'' OR $4 IS NOT NULL OR position<=$5 OR
      rank=(SELECT rank FROM ordered WHERE position=$5) ORDER BY position`,[season.id,q,Boolean(season.initialized_at),watch,count,jday(),mode==='official',encoded]);
    res.json(rows.map(withDisplayName));
  });
  app.get('/api/players/:id',read,async(req,res)=>{
    const season=await selectSeason(pool,req.query.season);
    if(!season) throw fail(404,'期のデータがありません');
    const sid=season.id;
    const pid=playerId(req.params.id);
    const {rows:[player]}=await pool.query(`SELECT p.*,o.rank official_rank,o.points official_points,
      CASE WHEN $3 THEN r.rank END provisional_rank,CASE WHEN $3 THEN r.points END provisional_points,t.backfill_status
      FROM players p LEFT JOIN official_rankings o ON o.dmp_id=p.dmp_id AND o.season_id=$1
      LEFT JOIN tracked_players t ON t.dmp_id=p.dmp_id AND t.season_id=$1
      LEFT JOIN provisional_rankings r ON r.dmp_id=p.dmp_id AND r.season_id=$1
        AND t.active AND t.backfill_status IN ('ready','stale') AND r.status IN ('ready','stale') WHERE p.dmp_id=$2`,[sid,pid,Boolean(season.initialized_at)]);
    if(!player) throw fail(404,'選手が見つかりません');
    const provisionalVisible=player.provisional_rank!==null;
    const eventRows=await pool.query(`SELECT e.id,e.event_date::text,e.event_name,e.grade,e.is_team,r.placement,r.total_points,r.rank_points,r.judge_bonus,
      r.official_counted,CASE WHEN $3 THEN r.provisional_counted END provisional_counted,r.coverage FROM event_results r JOIN events e ON e.id=r.event_id
      WHERE e.season_id=$1 AND r.dmp_id=$2 AND r.active ORDER BY e.event_date DESC,e.id DESC`,[sid,pid,provisionalVisible]);
    const [weekly,history,official,rules]=await Promise.all([
      pool.query('SELECT week_start::text,total_points FROM weekly_points WHERE season_id=$1 AND dmp_id=$2 AND $3 ORDER BY week_start',[sid,pid,provisionalVisible]),
      pool.query('SELECT observed_at,rank,points,status FROM provisional_history WHERE season_id=$1 AND dmp_id=$2 AND $3 ORDER BY observed_at,id',[sid,pid,provisionalVisible]),
      pool.query('SELECT aggregation_at,rank,points FROM official_history WHERE season_id=$1 AND dmp_id=$2 ORDER BY aggregation_at',[sid,pid]),
      pool.query('SELECT grade_rules FROM aggregation_rules WHERE season_id=$1 ORDER BY version DESC LIMIT 1',[sid])
    ]);
    res.json({player:withDisplayName(player),season,provisional_visible:provisionalVisible,grade_rules:rules.rows[0]?.grade_rules,events:eventRows.rows,weekly:weekly.rows,history:history.rows,official:official.rows});
  });
  app.get('/api/borders',read,async(req,res)=>{
    const season=await selectSeason(pool,req.query.season);
    if(!season) return res.json({official:[],provisional:[]});
    const n=bounded(req.query.n??100,200);
    const {rows:official}=await pool.query(`SELECT aggregation_at at, (array_agg(points ORDER BY rank,dmp_id))[$2] points
      FROM official_history WHERE season_id=$1 GROUP BY aggregation_at ORDER BY aggregation_at`,[season.id,n]);
    const {rows:provisional}=await pool.query(`WITH marks AS (
      SELECT max(observed_at) observed_at FROM provisional_history WHERE season_id=$1 AND $3
        GROUP BY (observed_at AT TIME ZONE 'Asia/Tokyo')::date
      UNION
      SELECT observed_at FROM (SELECT DISTINCT observed_at FROM provisional_history WHERE season_id=$1 AND $3
        ORDER BY observed_at DESC LIMIT 100) recent
    )
    SELECT m.observed_at at, (
      SELECT points FROM (SELECT DISTINCT ON(dmp_id) dmp_id,points,tracked,status FROM provisional_history
        WHERE season_id=$1 AND observed_at<=m.observed_at ORDER BY dmp_id,observed_at DESC,id DESC) state
      WHERE tracked AND status IN ('ready','stale') AND points IS NOT NULL ORDER BY points DESC,dmp_id OFFSET ($2::int-1) LIMIT 1
    ) points FROM marks m ORDER BY m.observed_at`,[season.id,n,Boolean(season.initialized_at)]);
    const {rows:[coverage]}=await pool.query(`SELECT count(*) FILTER(WHERE active AND backfill_status<>'ready')::int incomplete,
      count(*) FILTER(WHERE active AND backfill_status='stale')::int stale FROM tracked_players WHERE season_id=$1`,[season.id]);
    res.json({official,provisional,coverage});
  });
  app.get('/api/events',read,async(req,res)=>{
    const season=await selectSeason(pool,req.query.season);
    if(!season) return res.json([]);
    const period=['past','upcoming'].includes(req.query.period)?req.query.period:'all';
    const filters=[season.id,req.query.from?date(req.query.from):null,req.query.to?date(req.query.to):null,
      String(req.query.pref??'').slice(0,30),grades.includes(req.query.grade)?req.query.grade:'',String(req.query.status??'').slice(0,20),
      String(req.query.q??'').toLowerCase().slice(0,100),int(req.query.offset??0),period,jday()];
    const {rows:[result]}=await pool.query(`WITH classified AS (
      SELECT e.id,e.event_date,e.event_name,e.grade,e.prefecture,e.shop_name,e.is_team,e.multiplier,e.result_status,e.last_fetched_at,
        e.official_reflected_at,EXISTS(SELECT 1 FROM event_results r WHERE r.event_id=e.id AND r.active AND r.source='personal') personal_saved,
        CASE WHEN e.event_date>$10 THEN 'upcoming'
          WHEN EXISTS(SELECT 1 FROM fetch_jobs j WHERE j.dedupe_key='event:'||e.id AND j.status='failed') THEN 'failed'
          WHEN e.last_fetched_at IS NOT NULL THEN 'fetched'
          WHEN EXISTS(SELECT 1 FROM event_results r WHERE r.event_id=e.id AND r.active AND r.source='personal') THEN 'partial'
          WHEN e.multiplier IS NOT NULL THEN 'registered' ELSE 'unregistered' END display_status
      FROM events e WHERE season_id=$1
    ), filtered AS MATERIALIZED (
      SELECT * FROM classified WHERE ($2::date IS NULL OR event_date>=$2) AND ($3::date IS NULL OR event_date<=$3)
      AND ($4='' OR prefecture=$4) AND ($5='' OR grade=$5) AND ($6='' OR (CASE WHEN $11 THEN display_status ELSE result_status END)=$6) AND strpos(lower(event_name),$7)>0
      AND ($9='all' OR ($9='past' AND event_date<=$10) OR ($9='upcoming' AND event_date>$10))
    ), page AS (
      SELECT * FROM filtered ORDER BY CASE WHEN $9='upcoming' THEN event_date END ASC,event_date DESC,id DESC LIMIT 101 OFFSET $8
    )
    SELECT (SELECT count(*)::int FROM filtered) AS total,coalesce((SELECT jsonb_agg((to_jsonb(p)||jsonb_build_object('id',p.id::text)) ORDER BY
      CASE WHEN $9='upcoming' THEN p.event_date END ASC,p.event_date DESC,p.id DESC) FROM page p),'[]'::jsonb) AS events,
    CASE WHEN $11 THEN ARRAY(SELECT DISTINCT prefecture FROM events WHERE season_id=$1 AND prefecture IS NOT NULL AND prefecture<>'' ORDER BY prefecture) END prefectures`,
    [...filters,req.query.meta==='1']);
    // Preserve the legacy array contract for installed clients.
    res.json(req.query.meta==='1'?result:result.events);
  });
  app.get('/api/events/:id',read,async(req,res)=>{
    const eventId=id(req.params.id);
    const {rows:[event]}=await pool.query(`SELECT e.*,event_date::text,
      EXISTS(SELECT 1 FROM fetch_jobs j WHERE j.dedupe_key='event:'||e.id AND j.status='failed') result_failed,
      EXISTS(SELECT 1 FROM event_results r WHERE r.event_id=e.id AND r.active AND r.source='personal') personal_saved
      FROM events e WHERE id=$1`,[eventId]);
    if(!event) throw fail(404,'大会が見つかりません');
    const {rows}=await pool.query(`SELECT r.dmp_id,p.handle_name,r.placement,r.total_points,r.rank_points,r.judge_bonus,t.active tracked
      FROM event_results r JOIN players p USING(dmp_id)
      LEFT JOIN tracked_players t ON t.dmp_id=r.dmp_id AND t.season_id=$2
      WHERE r.event_id=$1 AND r.active AND r.total_points>0 ORDER BY placement,r.dmp_id`,[eventId,event.season_id]);
    const url=new URL('https://www.dmp-ranking.com/result.asp');
    url.search=new URLSearchParams({ShopID:event.shop_id,EventID:event.source_event_id,Seq:event.held_id});
    res.json({event,rows:rows.map(withDisplayName),url:url.href});
  });
  app.post('/api/watch',limit('watch',12),browserOnly,async(req,res)=>{
    const ids=[...new Set((Array.isArray(req.body?.ids)?req.body.ids:[]).slice(0,30).map(playerId))];
    if(!ids.length) return res.status(204).end();
    await transaction(pool,async db=>{
      const season=await selectSeason(db,req.body?.season);
      if(!season||season.finalized_at||!(season.starts_on<=jday()&&season.ends_on>=jday())) return;
      await seasonLock(db,season.id);
      const {rows}=await db.query('SELECT dmp_id FROM players WHERE dmp_id=ANY($1::int[]) ORDER BY dmp_id',[ids]);
      const {rows:[count]}=await db.query("SELECT count(*)::int n FROM tracked_players WHERE season_id=$1 AND 'watch'=ANY(reasons)",[season.id]);
      const {rows:[newWatch]}=await db.query("SELECT count(*)::int n FROM tracked_players WHERE season_id=$1 AND dmp_id=ANY($2::int[]) AND 'watch'=ANY(reasons)",[season.id,ids]);
      if(count.n+rows.length-newWatch.n>500) throw fail(429,'ウォッチ追跡上限です');
      for(const row of rows) await track(db,season.id,row.dmp_id,'watch');
      await setSetting(db,'watch_version',randomBytes(8).toString('hex'));
    });
    res.status(204).end();
  });
  app.use('/admin/api',limit('admin',100),(_,res,next)=>{res.set('Cache-Control','no-store');next();});
  app.post('/admin/api/login',limit('login',5),browserOnly,async(req,res)=>{
    const {login,password}=req.body??{};
    if(typeof login!=='string'||typeof password!=='string'||login.length>100||password.length>200) throw fail(400,'入力が無効です');
    const {rows:[account]}=await pool.query('SELECT * FROM admin_accounts WHERE login=$1',[login]);
    const [salt,expected]=(account?.password_hash??'absent:absent').split(':');
    if(!equal(secretHash(password,salt),expected)||!account) throw fail(401,'認証に失敗しました');
    const token=randomBytes(32).toString('hex');
    await pool.query(`INSERT INTO admin_sessions VALUES($1,$2,now()+interval '8 hours')`,[hash(token),account.id]);
    res.cookie('dmp_session',token,{httpOnly:true,secure,sameSite:'strict',maxAge:8*3600000,path:'/admin/api'}).status(204).end();
  });
  app.use('/admin/api',authenticated);
  app.post('/admin/api/logout',browserOnly,async(req,res)=>{
    await pool.query('DELETE FROM admin_sessions WHERE session_hash=$1',[req.adminSession]);
    res.clearCookie('dmp_session',{path:'/admin/api',secure,sameSite:'strict',httpOnly:true}).status(204).end();
  });
  const waitingByPriority=db=>db.query(`SELECT priority,status,count(*)::int AS count FROM fetch_jobs
    WHERE status IN ('pending','running','held','cancelled') AND NOT legacy_queue GROUP BY priority,status`);
  app.get('/admin/api/candidates',async(req,res)=>{
    const snapshot=await transaction(pool,async db=>{
      await db.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
      const season=await selectSeason(db,req.query.season);
      if(!season) throw fail(404,'期が見つかりません');
      return candidatePreview(db,season.id);
    });
    res.json(snapshot);
  });
  app.get('/admin/api/telemetry',async(req,res)=>{
    const kind=req.query.kind;
    if(kind==='official') {
      const season=await selectSeason(pool,req.query.season);
      const {rows:[row]}=await pool.query('SELECT max(aggregation_at) AS time FROM official_rankings WHERE season_id=$1',[season?.id??null]);
      return res.json(row);
    }
    if(kind==='database') {
      const {rows:[row]}=await pool.query(`SELECT value AS database,updated_at AS database_at,
        (SELECT value FROM app_settings WHERE key='database_measurement_failed') AS database_error_at
        FROM app_settings WHERE key='database_bytes'`);
      return res.json(row??{database:null});
    }
    const {rows:[slots]}=await pool.query(`WITH local AS (SELECT (now() AT TIME ZONE 'Asia/Tokyo')::date AS day)
      SELECT (SELECT count(*)::int FROM backfill_daily_events b WHERE b.day=local.day AND
        (b.reservation_token IS NULL OR NOT EXISTS (SELECT 1 FROM fetch_jobs j WHERE j.lease_token=b.reservation_token
          AND j.status='running' AND j.lease_until>clock_timestamp()))) AS backfill,
        (SELECT count(*)::int FROM candidate_daily_players c WHERE c.day=local.day AND
        (c.reservation_token IS NULL OR NOT EXISTS (SELECT 1 FROM fetch_jobs j WHERE j.lease_token=c.reservation_token
          AND j.status='running' AND j.lease_until>clock_timestamp()))) AS candidates FROM local`);
    res.json({slots,...await usage(pool)});
  });
  app.get('/admin/api/completion',async(req,res)=>{
    const season=await selectSeason(pool,req.query.season);
    const [progress,activity,queues,paused,cooldown]=await Promise.all([completionProgress(pool,season?.id??null),
      jobActivity(pool),waitingByPriority(pool),setting(pool,'paused',false),setting(pool,'dmp_next_request',0)]);
    res.json({...progress,...activity,queues:queues.rows,paused,cooldown:cooldown>Date.now()?cooldown:null});
  });
  app.get('/admin/api/held-results',async(req,res)=>{
    const result=await transaction(pool,async db=>{
      await db.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
      const season=await selectSeason(db,req.query.season);
      if(!season) throw fail(404,'期が見つかりません');
      return heldResultReview(db,season.id);
    });
    res.json(result);
  });
  app.get('/admin/api/queue-review',async(req,res)=>{
    const preview=await transaction(pool,async db=>{
      await db.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
      return queueReview(db);
    });
    res.json(preview);
  });
  app.get('/admin/api/queue-migration',async(req,res)=>{
    const changes=await transaction(pool,async db=>{
      await db.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
      return queueMigration(db);
    });
    res.json({total:changes.length,counts:Object.fromEntries(Object.entries(Object.groupBy(changes,r=>r.status+' / P'+r.priority+' / '+r.reason))
      .map(([key,group])=>[key,group.length])),changes});
  });
  app.get('/admin/api/status',async(req,res)=>{
    const season=await selectSeason(pool,req.query.season);
    const results=await Promise.all([
      jobActivity(pool),
      usage(pool),
      pool.query(`SELECT priority,status,count(*)::int AS count FROM fetch_jobs
        WHERE status IN ('pending','running','held','cancelled') AND NOT legacy_queue GROUP BY priority,status`),
      pool.query(`SELECT (SELECT count(*)::int FROM backfill_daily_events b WHERE day=(now() AT TIME ZONE 'Asia/Tokyo')::date
          AND (b.reservation_token IS NULL OR NOT EXISTS (
            SELECT 1 FROM fetch_jobs j WHERE j.lease_token=b.reservation_token AND j.status='running'
              AND j.lease_until>clock_timestamp()))) AS used,
        (SELECT count(*)::int FROM fetch_jobs WHERE legacy_queue AND status IN ('pending','failed','held','running')) AS legacy,
        (SELECT count(*)::int FROM fetch_jobs WHERE NOT legacy_queue AND priority=4 AND type='event' AND status='done') AS completed,
        (SELECT min(next_run_at) FROM fetch_jobs WHERE NOT legacy_queue AND priority=4 AND status IN ('pending','failed')) AS due`),
      pool.query('SELECT * FROM sync_discrepancies WHERE season_id=$1 ORDER BY aggregation_at DESC,dmp_id LIMIT 250',[season?.id??null]),
      pool.query('SELECT * FROM backup_history ORDER BY id DESC LIMIT 12'),
      pool.query('SELECT dmp_id,reasons,active,backfill_status FROM tracked_players WHERE season_id=$1 ORDER BY dmp_id LIMIT 500',[season?.id??null]),
      pool.query('SELECT coalesce(sum(bytes),0)::text bytes,coalesce(sum(duration),0)::text duration,coalesce(sum(records),0)::text records FROM fetch_logs WHERE created_at>=now()-interval \'30 days\''),
      pool.query(`SELECT c.id,c.detected_at,c.changed_fields,r.dmp_id,r.event_id FROM event_result_changes c
        JOIN event_results r ON r.id=c.event_result_id JOIN events e ON e.id=r.event_id
        WHERE e.season_id=$1 ORDER BY c.id DESC LIMIT 50`,[season?.id??null]),
      pool.query(`SELECT id,event_name,event_date::text,range_check FROM events WHERE season_id=$1
        AND (range_check->>'outside')::int>0 ORDER BY event_date DESC LIMIT 50`,[season?.id??null]),
      pool.query(`SELECT payload->>'id' AS id FROM fetch_jobs WHERE type='verify-player' AND payload->>'season'=$1::text
        ORDER BY id DESC LIMIT 1`,[season?.id??null]),
      pool.query('SELECT dmp_id,evaluated_at,details FROM tracking_candidate_decisions WHERE season_id=$1 ORDER BY evaluated_at DESC LIMIT 50',[season?.id??null]),
      pool.query('SELECT version,weekly_limit,grade_rules FROM aggregation_rules WHERE season_id=$1 ORDER BY version DESC LIMIT 1',[season?.id??null])
    ]);
    const [activity,acquisition,queues,backfill,...rows]=results;
    const now=new Date();
    const local=jst(now);
    const day=local.slice(0,10);
    const at=backfill.rows[0].due;
    const windowOpen=Number(local.slice(11,13))<12;
    const due=new Date(Math.max(+now,+(at?new Date(at):now)));
    const nextDay=instant=>new Date(Date.parse(jst(instant).slice(0,10)+'T00:00:00+09:00')+86400000);
    const next=at&&acquisition.configuration.backfillEnabled&&acquisition.level===0
      ? Number(jst(due).slice(11,13))>=12||jst(due).slice(0,10)===day&&backfill.rows[0].used>=acquisition.configuration.backfillLimit
        ? nextDay(due) : due : null;
    const [discrepancies,backups,tracked,traffic,changes,rangeChecks,lastVerification,candidateDecisions,rules]=rows.map(result=>result.rows);
    res.json({season,...activity,acquisition,queues:queues.rows,backfill:{...backfill.rows[0],windowOpen,next},discrepancies,backups,tracked,changes,rangeChecks,candidateDecisions,lastVerification:lastVerification[0]?.id??null,traffic:traffic[0],rules:rules[0],bytes:await setting(pool,'database_bytes',null),
      budget:acquisition.configuration.dbBudget,paused:await setting(pool,'paused',false),schedule:await setting(pool,'schedule',{}),
      source:await setting(pool,'source_mapping',{}),multiplierRanges:await setting(pool,'multiplier_ranges',{})});
  });
  app.get('/admin/api/verification/:id',async(req,res)=>{
    const season=await selectSeason(pool,req.query.season);
    const pid=playerId(req.params.id);
    const key=verificationKey(season?.id,pid);
    const {rows:[job]}=await pool.query(`SELECT j.status,j.attempts,j.last_error,j.next_run_at,p.dmp_id,p.handle_name,s.value AS result
      FROM fetch_jobs j JOIN players p ON p.dmp_id=$2 LEFT JOIN app_settings s ON s.key=j.dedupe_key WHERE j.dedupe_key=$1`,[key,pid]);
    if(!job) throw fail(404,'選手の検証ジョブが見つかりません');
    const {result,...status}=job;
    res.json({job:withDisplayName(status),result,fetchEnabled:process.env.ALLOW_DMP_FETCH==='true',
      paused:await setting(pool,'paused',false)});
  });
  app.post('/admin/api/action',browserOnly,async(req,res)=>{
    const body=req.body??{};
    const result=await transaction(pool,async db=>{
      const season=await selectSeason(db,body.season);
      if(body.action==='pause') {
        await db.query('SELECT pg_advisory_xact_lock(440004)');
        await setSetting(db,'paused',body.value===true);
        if(body.value!==true) await schedule(db);
        return;
      }
      if(body.action==='backup') return enqueue(db,'backup',{},'manual-backup',0,{reopen:true});
      if(body.action==='retry-blank-placement') {
        if(body.confirm!==true||!season) throw fail(400,'対象期と再開の確認が必要です');
        return heldResultReview(db,season.id,{apply:true});
      }
      if(body.action==='queue-review') {
        if(body.confirm!==true) throw fail(400,'再分類の確認が必要です');
        return queueReview(db,{apply:true});
      }
      if(body.action==='queue-migration') {
        if(body.confirm!==true) throw fail(400,'移行の確認が必要です');
        if(!await setting(db,'paused',false)) throw fail(409,'取得を停止してください');
        try {return {migrated:(await queueMigration(db,{apply:true})).length};}
        catch(error) {
          if(error.message==='Running jobs must finish before migrating the queue') throw fail(409,'実行中のジョブが終了するまでお待ちください');
          throw error;
        }
      }
      if(body.action==='acquisition') {
        const value=body.value;
        const candidateLimit=value?.candidateLimit??(await setting(db,'acquisition',{})).candidateLimit??50;
        if(!value||typeof value.backfillEnabled!=='boolean'||
          !Number.isInteger(value.backfillLimit)||value.backfillLimit<1||value.backfillLimit>10000||
          !Number.isInteger(candidateLimit)||candidateLimit<1||candidateLimit>10000||
          !Number.isInteger(value.personalDays)||value.personalDays<1||value.personalDays>30||
          !Number.isSafeInteger(value.dbBudget)||value.dbBudget<1||
          value.trafficBudget!==null&&(!Number.isSafeInteger(value.trafficBudget)||value.trafficBudget<1)) {
          throw fail(400,'取得設定が無効です');
        }
        const {backfillEnabled,backfillLimit,personalDays,dbBudget,trafficBudget}=value;
        return setSetting(db,'acquisition',{backfillEnabled,backfillLimit,personalDays,dbBudget,trafficBudget,candidateLimit});
      }
      if(body.action==='create-season') {
        const starts=date(body.starts),ends=date(body.ends);
        const codes=[body.term,body.legacyTerm];
        if(codes.some(code=>typeof code!=='string'||!/^\d{1,12}$/.test(code))) throw fail(400,'期コードが無効です');
        const {rows:[row]}=await db.query('INSERT INTO seasons(source_term,legacy_term,starts_on,ends_on) VALUES($1,$2,$3,$4) RETURNING id',[...codes,starts,ends]);
        await db.query("INSERT INTO aggregation_rules(season_id,version,weekly_limit,grade_rules) VALUES($1,1,2,'{\"CS\":\"weekly\",\"CSE\":\"extra\",\"GP\":\"extra\",\"BN\":\"extra\"}')",[row.id]);
        return;
      }
      if(body.action==='schedule') {
        for(const [key,length] of [['high',3],['official',4]]) {
          if(!Array.isArray(body.value?.[key])||body.value[key].length!==length||body.value[key].some(n=>![5,10,15,20,30,60].includes(n))) throw fail(400,'間隔が無効です');
        }
        return setSetting(db,'schedule',body.value);
      }
      if(body.action==='multiplier-ranges') {
        const value=body.value;
        if(!value||typeof value!=='object'||Array.isArray(value)||Object.entries(value).some(([grade,ranges])=>
          !grades.includes(grade)||!ranges||typeof ranges!=='object'||Array.isArray(ranges)||
          Object.entries(ranges).some(([multiplier,rank])=>!/^\d+(?:\.\d+)?$/.test(multiplier)||!Number.isInteger(rank)||rank<0||rank>100000))) {
          throw fail(400,'倍率別付与範囲が無効です');
        }
        return setSetting(db,'multiplier_ranges',value);
      }
      if(body.action==='source-mapping') {
        if(!body.value||typeof body.value!=='object'||Array.isArray(body.value)) throw fail(400,'設定が無効です');
        return setSetting(db,body.action.replace('-','_'),body.value);
      }
      if(!season) throw fail(400,'期を作成してください');
      if(season.compacted_at&&body.action!=='finalize') throw fail(409,'圧縮済みの期です');
      await seasonLock(db,season.id);
      const sid=season.id;
      const payload={season:sid};
      if(body.action==='register-candidates') {
        if(body.confirm!==true) throw fail(400,'候補取得の確認が必要です');
        return enqueueCandidatePreview(db,sid);
      }
      if(body.action==='finalize') {
        if(season.ends_on>=jday()) throw fail(409,'期の終了後に確定できます');
        await db.query('UPDATE seasons SET finalized_at=coalesce(finalized_at,now()) WHERE id=$1',[sid]);
      } else if(body.action==='track') {
        await track(db,sid,playerId(body.id),'admin',body.value!==false);
        await recalculate(db,sid,[]);
      } else if(body.action==='personal') {
        const pid=playerId(body.id);
        await track(db,sid,pid,'admin');
        await enqueuePersonalBatch(db,sid,[pid],{priority:0,reason:'administrator',reopen:true,retry:true});
      } else if(body.action==='event') {
        const eid=id(body.id);
        const {rows}=await db.query('SELECT 1 FROM events WHERE id=$1 AND season_id=$2',[eid,sid]);
        if(!rows.length) throw fail(404,'大会が見つかりません');
        await enqueue(db,'event',{...payload,id:eid},'event:'+eid,0,{reopen:true,retry:true,reason:'administrator'});
      } else if(body.action==='rules') {
        const limit=int(body.limit);
        if(limit>20||grades.some(g=>!['weekly','extra','zero'].includes(body.grades?.[g]))) throw fail(400,'ルールが無効です');
        await db.query(`INSERT INTO aggregation_rules(season_id,version,weekly_limit,grade_rules)
          SELECT $1,coalesce(max(version),0)+1,$2,$3 FROM aggregation_rules WHERE season_id=$1`,[sid,limit,body.grades]);
        await recalculate(db,sid);
      } else if(body.action==='verify-player') {
        const query=typeof body.query==='string'?body.query.trim():'';
        if(!query||query.length>200) throw fail(400,'DMP ID またはハンドルネームを入力してください');
        const numeric=/^\d{1,10}$/.test(query)&&Number(query)>0&&Number(query)<=2147483647?Number(query):null;
        const encoded=await encodedNameMatches(db,query,true);
        const {rows:matches}=await db.query(`SELECT dmp_id FROM players
          WHERE dmp_id=$1 OR lower(btrim(handle_name))=lower($2) OR dmp_id=ANY($3::int[])
          ORDER BY (dmp_id=$1) DESC NULLS LAST,dmp_id LIMIT 2`,[numeric,query,encoded]);
        const player=matches[0];
        if(!player) throw fail(404,'登録済みの選手が見つかりません');
        if(matches.length>1&&player.dmp_id!==numeric) throw fail(409,'同名の選手が複数います。DMP IDを指定してください');
        const key=verificationKey(sid,player.dmp_id);
        await enqueue(db,'verify-player',{...payload,id:player.dmp_id},key,0,{reopen:true,retry:true,reason:'administrator'});
        await db.query(`UPDATE fetch_jobs SET status='pending',next_run_at=now(),attempts=0,last_error=NULL
          WHERE dedupe_key=$1 AND status='failed'`,[key]);
        return {player:player.dmp_id,season:sid};
      } else if(body.action==='initialize') {
        const {rows:players}=await db.query(`SELECT o.dmp_id,t.backfill_status,EXISTS(SELECT 1 FROM pending_personal_results p
          WHERE p.season_id=o.season_id AND p.dmp_id=o.dmp_id) stored FROM official_rankings o
          LEFT JOIN tracked_players t USING(season_id,dmp_id) WHERE o.season_id=$1 AND o.rank<=200 ORDER BY o.rank,o.dmp_id`,[sid]);
        if(!players.length) throw fail(409,'先に公式ランキングを取得してください');
        await trackMany(db,sid,players.map(player=>player.dmp_id),'official');
        await enqueuePersonalBatch(db,sid,players.filter(player=>player.backfill_status!=='ready'&&!player.stored).map(player=>player.dmp_id));
        await enqueueCompletion(db,sid);
      } else if(body.action==='complete-personal') {
        await enqueueCompletion(db,sid);
      } else if(body.action==='official-only') {
        await enqueue(db,'official-only',payload,'official-only:'+sid,0,{reopen:true,reason:'administrator'});
      } else if(body.action==='official') {
        await enqueueOfficial(db,sid,'official:manual:'+sid,{manual:true});
      } else if(body.action==='recalculate') {
        await enqueue(db,body.action,payload,body.action+':manual:'+sid,0,{reopen:true,reason:'administrator'});
      } else if(body.action==='reset-job') {
        await db.query(`UPDATE fetch_jobs SET status='pending',attempts=0,last_error=NULL,next_run_at=now()
          WHERE id=$1 AND payload->>'season'=$2 AND NOT legacy_queue AND (status IN ('pending','failed') OR type='event' AND status='held' AND last_error LIKE 'Invalid integer event=%')`,[id(body.id),String(sid)]);
      } else throw fail(400,'操作が無効です');
    });
    res.status(202).json({accepted:true,...result});
    worker?.kick().catch(()=>console.error('Worker cycle failed'));
  });
  app.use(['/api','/admin/api','/internal'],(_,res)=>res.status(404).json({error:'APIが見つかりません'}));
  const root=fileURLToPath(new URL('../public/',import.meta.url));
  app.use(express.static(root));
  app.get('/admin',(_,res)=>res.sendFile(root+'admin.html'));
  app.use((error,req,res,next)=>{
    if(res.headersSent) return next(error);
    const status=error.status??(['Invalid date','Invalid integer','Integer out of bounds'].includes(error.message)?400:
      ['23503','23505','23514','23P01','22008'].includes(error.code)?409:500);
    if(status===500) console.error('Request failed',error.code??error.name);
    res.status(status).json({error:status===500?'処理に失敗しました':status===409?'入力が既存データまたは制約と競合しています':error.message});
  });
  return app;
}
