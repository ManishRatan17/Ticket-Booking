// A tiny migration runner: applies each .sql file in server/migrations/ exactly once, in order.
// Run with: npm run migrate -w server
import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { pool } from '../config/db.js';

const MIGRATIONS_DIR = new URL('../../migrations/', import.meta.url);
const MIGRATIONS_LOCK = 740_002; // any number, shared by every process that runs migrations

export async function runMigrations({ log = console.log } = {}) {
  const client = await pool.connect(); // borrow ONE connection, so BEGIN/COMMIT apply to it
  try {
    // Only ONE migration run at a time, across processes: test files start in parallel, and in
    // production several servers may start together. The others wait here, then find nothing to do.
    await client.query('SELECT pg_advisory_lock($1)', [MIGRATIONS_LOCK]);
    // Remembers which files have already been applied.
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        name       TEXT PRIMARY KEY,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT now() 
      )`);

    const { rows } = await client.query('SELECT name FROM schema_migrations');
    const applied = new Set(rows.map((r) => r.name));

    // Files are named 001_..., 002_..., so sorting by name = sorting by order.
    const files = (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith('.sql')).sort();

    for (const file of files) {
      if (applied.has(file)) continue;
      const sql = await readFile(new URL(file, MIGRATIONS_DIR), 'utf8');

      // Transaction: either the whole file applies AND is recorded, or nothing changes.
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [file]);
        await client.query('COMMIT');
        log(`applied ${file}`);
      } catch (err) {
        await client.query('ROLLBACK');
        throw new Error(`Migration ${file} failed: ${err.message}`);
      }
    }
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [MIGRATIONS_LOCK]).catch(() => {});
    client.release(); // always hand the connection back to the pool
  }
}

// Only run when executed directly (`node src/db/migrate.js`), not when imported by tests.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    await runMigrations();
    console.log('migrations up to date');
  } catch (err) {
    console.error(err.message);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
}
