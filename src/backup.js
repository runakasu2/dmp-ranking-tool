import {createHash, randomUUID} from 'node:crypto';
import {mkdir,readFile,writeFile,rename,unlink} from 'node:fs/promises';
import {join,basename} from 'node:path';
import {pathToFileURL} from 'node:url';
import {connect,migrate,transaction} from './db.js';

const tables=['players','player_name_history','seasons','aggregation_rules','events','event_results','event_result_changes','official_rankings','official_history','weekly_points','provisional_rankings','aggregation_batches','provisional_history','tracked_players','fetch_jobs','job_event_pages','fetch_logs','sync_discrepancies','app_settings','backup_history','pending_personal_results','backfill_daily_events','personal_fetch_coverage','official_update_baselines','dmp_traffic_daily','tracking_candidate_decisions','candidate_daily_players'];
const acquisitionTables=new Set(['backfill_daily_events','personal_fetch_coverage','official_update_baselines','dmp_traffic_daily','tracking_candidate_decisions','candidate_daily_players']);
const identity=new Set(['seasons','events','event_results','event_result_changes','aggregation_batches','provisional_history','fetch_jobs','fetch_logs','backup_history']);
export const checksum=body=>createHash('sha256').update(body).digest('hex');
export async function exportData(db) {
  const entries=[];
  for(const table of tables) {
    const {rows:[row]}=await db.query(`SELECT coalesce(jsonb_agg(to_jsonb(data) ORDER BY to_jsonb(data)),'[]'::jsonb)::text AS data FROM ${table} data`);
    entries.push(JSON.stringify(table)+':'+row.data);
  }
  return '{"version":1,"tables":{'+entries.join(',')+'}}';
}
export async function importData(db,body) {
  // Let PostgreSQL parse BIGINT values directly from the original JSON text.
  const {rows:[meta]}=await db.query("SELECT $1::jsonb->>'version' version,jsonb_typeof($1::jsonb->'tables') kind",[body]);
  if(meta.version!=='1'||meta.kind!=='object') throw new Error('Invalid backup envelope');
  for(const table of tables) {
    if(acquisitionTables.has(table)
      && !(await db.query("SELECT $1::jsonb->'tables' ? $2 AS present",[body,table])).rows[0].present) continue;
    const legacyDefaults=table==='fetch_jobs'
      ? `'{"legacy_queue":false}'::jsonb||CASE WHEN item ? 'legacy_queue' THEN '{}'::jsonb WHEN item->>'status' IN ('pending','failed','running') THEN '{"legacy_queue":true}'::jsonb ELSE '{}'::jsonb END`
      : table==='events'?`'{"urgent_fetch":false}'::jsonb`:" '{}'::jsonb";
    await db.query(`INSERT INTO ${table} ${identity.has(table)?'OVERRIDING SYSTEM VALUE':''}
      SELECT (jsonb_populate_record(NULL::${table},${legacyDefaults}||item)).* FROM jsonb_array_elements($1::jsonb->'tables'->$2) x(item)`,[body,table]);
    if(identity.has(table)) await db.query(`SELECT setval(pg_get_serial_sequence($1,'id'),greatest(coalesce(max(id),0),1),max(id) IS NOT NULL) FROM ${table}`,[table]);
  }
}
async function matchesBackup(db,body) {
  if(await exportData(db)===body) return true;
  // Older exports omit nullable columns added by migrations. Normalize the
  // expected data with the same typed rows the importer uses.
  const defaults={fetch_jobs:{started_at:null,finished_at:null,legacy_queue:false,reason:null},
    backfill_daily_events:{reservation_token:null},
    events:{first_fetched_at:null,registration_transition_at:null,urgent_fetch:false},
    fetch_logs:{started_at:null,finished_at:null,phase_ms:null,received_bytes:null}};
  for(const table of tables) {
    if(acquisitionTables.has(table)
      && !(await db.query("SELECT $1::jsonb->'tables' ? $2 AS present",[body,table])).rows[0].present) continue;
    const expectedJob=table==='fetch_jobs'?`|| CASE WHEN NOT (item ? 'legacy_queue') AND item->>'status' IN ('pending','failed','running')
      THEN '{"legacy_queue":true}'::jsonb ELSE '{}'::jsonb END`:'';
    const {rows:[row]}=await db.query(`SELECT
      (SELECT coalesce(jsonb_agg(to_jsonb(x) ORDER BY to_jsonb(x)),'[]'::jsonb) FROM ${table} x)=
      (SELECT coalesce(jsonb_agg(expected ORDER BY expected),'[]'::jsonb)
       FROM (SELECT $3::jsonb||item${expectedJob} expected FROM jsonb_array_elements($1::jsonb->'tables'->$2) x(item)) y)
      AND jsonb_typeof($1::jsonb->'tables'->$2)='array' AS matches`,[body,table,defaults[table]??{}]);
    if(!row.matches) return false;
  }
  return true;
}
export async function verifyBackup(db,body) {
  const schema='verify_'+randomUUID().replaceAll('-','');
  await db.query('CREATE SCHEMA '+schema);
  await db.query('SET LOCAL search_path TO '+schema);
  await migrate(db);
  await importData(db,body);
  if(!await matchesBackup(db,body)) throw new Error('Backup round trip differs');
  await db.query('DROP SCHEMA '+schema+' CASCADE');
  await db.query('SET LOCAL search_path TO public');
}
export async function backup(pool,force=false,directory=process.env.BACKUP_DIRECTORY) {
  return transaction(pool,async db=>{
    await db.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');
    const {rows:[lock]}=await db.query('SELECT pg_try_advisory_xact_lock(440003) locked');
    if(!lock.locked) return;
    const {rows}=await db.query("SELECT 1 FROM backup_history WHERE status IN ('verified','unconfigured') AND created_at>now()-interval '7 days'");
    if(!force&&rows.length) return;
    if(!directory) {
      await db.query("INSERT INTO backup_history(status) VALUES('unconfigured')");
      return;
    }
    const body=await exportData(db);
    const hash=checksum(body);
    const file=new Date().toISOString().replaceAll(':','-')+'-'+hash.slice(0,12)+'.json';
    await mkdir(directory,{recursive:true,mode:0o700});
    const temp=join(directory,file+'.tmp');
    await writeFile(temp,body,{flag:'wx',mode:0o600});
    const saved=await readFile(temp,'utf8');
    if(checksum(saved)!==hash) throw new Error('Backup checksum differs');
    await verifyBackup(db,saved);
    await rename(temp,join(directory,file));
    await db.query("INSERT INTO backup_history(status,storage_reference,checksum,verified_at) VALUES('verified',$1,$2,now())",[file,hash]);
    const expired=await db.query("SELECT id,storage_reference FROM backup_history WHERE status='verified' ORDER BY id DESC OFFSET 4");
    for(const row of expired.rows) {
      if(row.storage_reference!==basename(row.storage_reference)) continue;
      await unlink(join(directory,row.storage_reference)).catch(error=>{if(error.code!=='ENOENT') throw error;});
      await db.query("UPDATE backup_history SET status='expired' WHERE id=$1",[row.id]);
    }
    return {file,checksum:hash};
  });
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href) {
  const [command,file,hash]=process.argv.slice(2);
  const pool=connect();
  try {
    if(command==='export') {
      const body=await transaction(pool,async db=>{await db.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');return exportData(db);});
      await writeFile(file,body,{flag:'wx',mode:0o600});
      console.log(checksum(body));
    } else if(command==='restore') {
      const body=await readFile(file,'utf8');
      if(checksum(body)!==hash) throw new Error('Backup checksum differs');
      await transaction(pool,async db=>{
        await db.query('LOCK TABLE '+tables.join(',')+' IN ACCESS EXCLUSIVE MODE');
        for(const table of tables) if((await db.query('SELECT 1 FROM '+table+' LIMIT 1')).rows.length) throw new Error('Restore requires an empty migrated database');
        await importData(db,body);
        if(!await matchesBackup(db,body)) throw new Error('Restored data differs');
      });
    } else throw new Error('Use export FILE or restore FILE SHA256');
  } finally {await pool.end();}
}
