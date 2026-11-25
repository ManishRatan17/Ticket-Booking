import pg from 'pg';
import { env } from './env.js';

// A Pool keeps a few open connections to Postgres and lends them out per query.
// Opening a new connection for every request would be slow (TCP + auth handshake each time).
export const pool = new pg.Pool({
  connectionString: env.databaseUrl,
  max: env.dbPoolMax, // at most this many connections at once (default 20); extra queries wait in line
  connectionTimeoutMillis: 2000, // give up if Postgres doesn't answer within 2s
});

// If an idle connection breaks (e.g. Postgres restarted), pg emits 'error'.
// Without this listener, Node would treat it as unhandled and crash the server.
pool.on('error', (err) => {
  console.error('[postgres] idle client error:', err.message);
});

// Runs fn(client) inside BEGIN ... COMMIT on ONE borrowed connection.
// If fn throws, everything it did is rolled back. The connection is always returned.
//
//   const id = await withTransaction(async (client) => { ...client.query(...)... return id; });
//
// ⚠️ Throwing inside fn UNDOES its writes. If a write must be kept even though the request
// fails (e.g. revoking a session after detecting token theft), RETURN a result from fn and
// throw AFTER the transaction has committed.
export async function withTransaction(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {}); // don't hide the original error
    throw err;
  } finally {
    client.release();
  }
}

export async function checkPostgres() {
  await pool.query('SELECT 1');
}
