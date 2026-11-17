import pg from 'pg';
import { env } from './env.js';

// A Pool keeps a few open connections to Postgres and lends them out per query.
// Opening a new connection for every request would be slow (TCP + auth handshake each time).
export const pool = new pg.Pool({
  connectionString: env.databaseUrl,
  max: 10, // at most 10 connections at once; extra queries wait in line
  connectionTimeoutMillis: 2000, // give up if Postgres doesn't answer within 2s
});

// If an idle connection breaks (e.g. Postgres restarted), pg emits 'error'.
// Without this listener, Node would treat it as unhandled and crash the server.
pool.on('error', (err) => {
  console.error('[postgres] idle client error:', err.message);
});

export async function checkPostgres() {
  await pool.query('SELECT 1');
}
