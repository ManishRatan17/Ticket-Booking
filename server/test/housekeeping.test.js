// The daily housekeeping job trims what's useless, and keeps everything else. Requires Docker.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { pool } from '../src/config/db.js';
import { runMigrations } from '../src/db/migrate.js';
import { closeConnections } from '../src/config/connections.js';
import { runHousekeeping } from '../src/jobs/housekeeping.js';
import { processors } from '../src/jobs/processors.js';
import { createSignedInUsers } from '../test-support/users.js';

await runMigrations({ log: () => {} });
const RUN = `test-housekeeping-${randomUUID().slice(0, 8)}`;

after(async () => {
  await pool.query('DELETE FROM processed_webhooks WHERE webhook_id LIKE $1', [`${RUN}%`]);
  await pool.query('DELETE FROM users WHERE email LIKE $1', [`${RUN}%`]);
  await closeConnections();
});

const session = async (userId, { expiresAgo = null, revokedAgo = null } = {}) =>
  (
    await pool.query(
      `INSERT INTO sessions (user_id, expires_at, revoked_at)
       VALUES ($1, now() - make_interval(days => $2::int), CASE WHEN $3::int IS NULL THEN NULL ELSE now() - make_interval(days => $3::int) END)
       RETURNING id`,
      [userId, expiresAgo ?? -1, revokedAgo],
    )
  ).rows[0].id;
const exists = async (table, column, value) => (await pool.query(`SELECT 1 FROM ${table} WHERE ${column} = $1`, [value])).rowCount === 1;

test('removes long-dead sessions (and their refresh tokens), keeps living and recent ones', async () => {
  const [ann] = await createSignedInUsers(1, { prefix: RUN });
  const oldExpired = await session(ann.id, { expiresAgo: 31 });
  const oldRevoked = await session(ann.id, { revokedAgo: 31 });
  const recentRevoked = await session(ann.id, { revokedAgo: 2 }); // still shown in "my sessions" history
  const alive = await session(ann.id);
  await pool.query(
    "INSERT INTO refresh_tokens (session_id, token_hash, expires_at) VALUES ($1, $2, now() - interval '30 days')",
    [oldExpired, `${RUN}-hash`],
  );

  const { deleted } = await runHousekeeping();
  assert.ok(deleted.sessions >= 2);
  assert.equal(await exists('sessions', 'id', oldExpired), false);
  assert.equal(await exists('sessions', 'id', oldRevoked), false);
  assert.equal(await exists('refresh_tokens', 'token_hash', `${RUN}-hash`), false, 'cascades with its session');
  assert.equal(await exists('sessions', 'id', recentRevoked), true);
  assert.equal(await exists('sessions', 'id', alive), true);
});

test('removes stale reset links and old webhook records; keeps fresh ones', async () => {
  const [ann] = await createSignedInUsers(1, { prefix: `${RUN}-b` });
  await pool.query(
    `INSERT INTO password_reset_tokens (user_id, token_hash, expires_at) VALUES
       ($1, $2, now() - interval '2 days'), ($1, $3, now() + interval '10 minutes')`,
    [ann.id, `${RUN}-old`, `${RUN}-new`],
  );
  await pool.query(
    `INSERT INTO processed_webhooks (webhook_id, provider, received_at) VALUES
       ($1, 'fake', now() - interval '31 days'), ($2, 'fake', now() - interval '1 day')`,
    [`${RUN}-old`, `${RUN}-new`],
  );

  await processors.housekeeping(); // as the worker runs it
  assert.equal(await exists('password_reset_tokens', 'token_hash', `${RUN}-old`), false);
  assert.equal(await exists('password_reset_tokens', 'token_hash', `${RUN}-new`), true);
  assert.equal(await exists('processed_webhooks', 'webhook_id', `${RUN}-old`), false);
  assert.equal(await exists('processed_webhooks', 'webhook_id', `${RUN}-new`), true, 'a repeat within 30 days is still recognised');
});
