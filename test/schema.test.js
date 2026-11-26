import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
import { migrate } from '../src/db.js';
test('migration is repeatable and rejects overlapping seasons and invalid DMP IDs', async () => {
  const db = new PGlite();
  try {
    await db.transaction(migrate);
    await db.transaction(migrate);
    await db.query("INSERT INTO seasons(source_term,legacy_term,starts_on,ends_on) VALUES('1','2','2026-01-01','2026-06-30')");
    await assert.rejects(db.query("INSERT INTO seasons(source_term,legacy_term,starts_on,ends_on) VALUES('3','4','2026-06-30','2026-12-31')"));
    await assert.rejects(db.query("INSERT INTO players(dmp_id,handle_name) VALUES(0,'fixture')"));
  } finally { await db.close(); }
});
