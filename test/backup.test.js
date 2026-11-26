import {test} from 'node:test';
import assert from 'node:assert/strict';
import {PGlite} from '@electric-sql/pglite';
import {migrate} from '../src/db.js';
import {checksum,exportData,verifyBackup} from '../src/backup.js';

test('backup round trip preserves BIGINT, tables and checksum',async()=>{
  const db=new PGlite();
  try {
    await db.transaction(migrate);
    await db.query("INSERT INTO seasons(id,source_term,legacy_term,starts_on,ends_on) OVERRIDING SYSTEM VALUE VALUES(9007199254740993,'N','L','2026-11-01','2026-12-31')");
    const body=await exportData(db);
    assert.match(body,/9007199254740993/);
    assert.notEqual(checksum(body),checksum(body+' '));
    await db.transaction(tx=>verifyBackup(tx,body));
    assert.equal(await exportData(db),body);
  } finally {await db.close();}
});

test('an export made before job telemetry fields can still be restored and verified',async()=>{
  const db=new PGlite();
  try{
    await db.transaction(migrate);
    await db.query("INSERT INTO fetch_jobs(type,payload,dedupe_key,priority) VALUES('test','{}','legacy',1)");
    await db.query("INSERT INTO fetch_logs(job_id,status,duration) VALUES(1,'done',123)");
    const current=JSON.parse(await exportData(db));
    for(const table of ['fetch_jobs','fetch_logs']) for(const row of current.tables[table]) {
      delete row.started_at;
      delete row.finished_at;
      delete row.phase_ms;
    }
    await db.transaction(tx=>verifyBackup(tx,JSON.stringify(current)));
  }finally{await db.close();}
});
