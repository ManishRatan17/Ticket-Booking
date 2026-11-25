// Admin → background jobs: counts, workers, schedule, and the dead-letter queue with Retry.
// Requires Docker. Jobs ON with a private queue prefix (set before the app is imported).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

const PREFIX = `test-adminjobs-${randomUUID().slice(0, 8)}`;
Object.assign(process.env, { JOBS_ENABLED: 'true', JOBS_PREFIX: PREFIX });

const { createApp } = await import('../src/app.js');
const { pool } = await import('../src/config/db.js');
const { redis } = await import('../src/config/redis.js');
const { runMigrations } = await import('../src/db/migrate.js');
const { closeConnections } = await import('../src/config/connections.js');
const { stockKey } = await import('../src/modules/reservation/stock.js');
const { createEvent } = await import('../src/modules/events/events.service.js');
const { getQueue, scheduleSweep } = await import('../src/jobs/queue.js');
const { createWorker } = await import('../src/jobs/worker.js');
const { createSignedInUsers } = await import('../test-support/users.js');
const { deleteEventKeys } = await import('../test-support/redis-cleanup.js');

await runMigrations({ log: () => {} });
const server = createApp().listen(0);
const baseUrl = `http://localhost:${server.address().port}`;
const worker = createWorker({ log: () => {} });

const RUN = `test-adminjobs-${randomUUID().slice(0, 8)}`;
const { holdWhileCreatingAdmins } = await import('../test-support/admin-lock.js');
const releaseAdminsLock = await holdWhileCreatingAdmins(); // see admin-lock.js
const [admin] = await createSignedInUsers(1, { prefix: `${RUN}-admin`, role: 'admin' });
const [user] = await createSignedInUsers(1, { prefix: `${RUN}-user` });

after(async () => {
  await worker.shutdown();
  await getQueue().obliterate({ force: true });
  const { rows } = await pool.query('SELECT id FROM events WHERE name LIKE $1', [`${RUN}%`]);
  const ids = rows.map((r) => r.id);
  await deleteEventKeys(ids);
  if (ids.length) {
    await pool.query('DELETE FROM orders WHERE event_id = ANY($1)', [ids]);
    await pool.query('DELETE FROM events WHERE id = ANY($1)', [ids]);
  }
  await pool.query('DELETE FROM users WHERE email LIKE $1', [`${RUN}%`]);
  await releaseAdminsLock(); // our admin is gone
  server.close();
  await closeConnections();
});

async function api(method, path, { as, body } = {}) {
  const headers = {};
  if (as) headers.Cookie = as.cookie;
  if (body) headers['Content-Type'] = 'application/json';
  const res = await fetch(`${baseUrl}${path}`, { method, headers, body: body && JSON.stringify(body) });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

async function eventually(check, ms = 8000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await check()) return true;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return false;
}

test('only admins can see the jobs page (user → 403, nobody → 401)', async () => {
  assert.equal((await api('GET', '/api/admin/jobs', { as: user })).status, 403);
  assert.equal((await api('GET', '/api/admin/jobs')).status, 401);
});

test('overview: counts for every state, workers online, the sweep schedule', async () => {
  await scheduleSweep();
  const { status, body } = await api('GET', '/api/admin/jobs', { as: admin });
  assert.equal(status, 200);
  assert.deepEqual(Object.keys(body.counts).sort(), ['active', 'completed', 'delayed', 'failed', 'waiting']);
  assert.ok(body.workersOnline >= 1, 'the test worker should be listed');
  const sweep = body.schedules.find((s) => s.name === 'sweep-expired');
  assert.equal(sweep.everyMs, 60_000);
});

test('dead-letter queue: a job that fails every attempt is KEPT, shown, and can be retried after a fix', async () => {
  // A hold that is NOT expired yet, and an expire job with only one attempt: it will fail.
  const e = await createEvent({ name: `${RUN} event`, totalTickets: 10, saleStartsAt: new Date(Date.now() - 60_000) });
  const h = (await api('POST', `/api/events/${e.id}/holds`, { as: user, body: { quantity: 2 } })).body.hold;
  await getQueue().add('expire-hold', { holdId: h.id }, { jobId: `manual-${h.id}`, attempts: 1 });

  assert.ok(await eventually(async () => (await getQueue().getJob(`manual-${h.id}`))?.isFailed()), 'job did not fail');
  const overview = (await api('GET', '/api/admin/jobs', { as: admin })).body;
  const failed = overview.failedJobs.find((j) => j.id === `manual-${h.id}`);
  assert.ok(failed, 'failed job not listed');
  assert.match(failed.error, /has not expired yet/);
  assert.equal(failed.attempts, 1);

  // "Fix the cause" (the hold's time is now up) and press Retry.
  await redis.hset(`hold:${h.id}`, 'expiresAt', Date.now() - 1000);
  assert.equal((await api('POST', `/api/admin/jobs/manual-${h.id}/retry`, { as: admin })).status, 202);

  assert.ok(await eventually(async () => (await getQueue().getJob(`manual-${h.id}`))?.isCompleted()), 'retry did not complete');
  assert.equal(Number(await redis.get(stockKey(e.id))), 10, 'the retried job released the tickets');
});

test('retry: unknown job → 404; a job that has not failed → 409', async () => {
  assert.equal((await api('POST', '/api/admin/jobs/no-such-job/retry', { as: admin })).status, 404);
  await getQueue().add('expire-hold', { holdId: randomUUID() }, { jobId: `${RUN}-later`, delay: 60_000 });
  const res = await api('POST', `/api/admin/jobs/${RUN}-later/retry`, { as: admin });
  assert.equal(res.status, 409);
  assert.equal(res.body.error.code, 'JOB_NOT_FAILED');
});
