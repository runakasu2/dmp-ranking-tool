import pg from 'pg';
import { readdir, readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

pg.types.setTypeParser(1082, value => value);

export function connect(url = process.env.DATABASE_URL) {
  if (!url) throw new Error('DATABASE_URL is required');
  const pool = new pg.Pool({ connectionString: url, max: 4, idleTimeoutMillis: 10000, connectionTimeoutMillis: 6000 });
  pool.on('error', error => console.error('Idle database connection closed', error.code ?? error.name));
  return pool;
}

export async function transaction(pool, work) {
  const db = await pool.connect();
  try {
    await db.query('BEGIN');
    const result = await work(db);
    await db.query('COMMIT');
    return result;
  } catch (error) {
    await db.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    db.release();
  }
}

export async function migrate(db) {
  await db.query('SELECT pg_advisory_xact_lock(440001)');
  await db.query('CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())');
  const directory = new URL('../migrations/', import.meta.url);
  for (const name of (await readdir(directory)).filter(name => name.endsWith('.sql')).sort()) {
    if ((await db.query('SELECT 1 FROM schema_migrations WHERE name=$1', [name])).rows.length) continue;
    const sql = await readFile(new URL(name, directory), 'utf8');
    if (db.exec) await db.exec(sql);
    else await db.query(sql);
    await db.query('INSERT INTO schema_migrations(name) VALUES($1)', [name]);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const pool = connect();
  try { await transaction(pool, migrate); } finally { await pool.end(); }
}
