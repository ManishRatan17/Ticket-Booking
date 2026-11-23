// Background jobs: abandoned holds and unpaid orders expire BY THEMSELVES. Requires Docker.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

// Turn jobs back on (.env.test switches them off for the rest of the suite), use a private
// queue prefix, and make holds last 1 second. Set BEFORE importing the app (env.js reads once).
const PREFIX = `test-jobs-${randomUUID().slice(0, 8)}`;
Object.assign(process.env, { JOBS_ENABLED: 'true', JOBS_PREFIX: PREFIX, HOLD_SECONDS: '1' });

const { createApp } = await import('../src/app.js');
const { pool } = await import('../src/config/db.js');
const { redis } = await import('../src/config/redis.js');
const { runMigrations } = await import('../src/db/migrate.js');
const { closeConnections } = await import('../src/config/connections.js');
const { stockKey } = await import('../src/modules/reservation/stock.js');
const { createEvent } = await import('../src/modules/events/events.service.js');
const { handlePaymentEvent } = await import('../src/modules/payments/payments.service.js');
const { getQueue } = await import('../src/jobs/queue.js');
const { createWorker } = await import('../src/jobs/worker.js');
const { expireHold } = await import('../src/jobs/processors.js');
const { createSignedInUsers } = await import('../test-support/users.js');
// (dynamic too: a normal import would load env.js BEFORE the settings above are applied)
const { deleteEventKeys } = await import('../test-support/redis-cleanup.js');


await runMigrations({ log: () => {} });
const server = createApp().listen(0);
const baseUrl = `http://localhost:${server.address().port}`;
const worker = createWorker({ log: () => {} }); // the CONSUMER, running inside this test process

const RUN = `test-jobs-${randomUUID().slice(0, 8)}`;
let n = 0;

after(async () => {
  await worker.shutdown();
  await getQueue().obliterate({ force: true }); // delete this test's queue and all its jobs
  const { rows } = await pool.query('SELECT id FROM events WHERE name LIKE $1', [`${RUN}%`]);
  const ids = rows.map((r) => r.id);
  if (ids.length) {
    await deleteEventKeys(ids);
    await pool.query('DELETE FROM sold_tickets WHERE event_id = ANY($1)', [ids]);
    await pool.query('DELETE FROM orders WHERE event_id = ANY($1)', [ids]);
    await pool.query('DELETE FROM events WHERE id = ANY($1)', [ids]);
  }
  await pool.query('DELETE FROM processed_webhooks WHERE webhook_id LIKE $1', [`${RUN}%`]);
  await pool.query('DELETE FROM users WHERE email LIKE $1', [`${RUN}%`]);
  server.close();
  await closeConnections();
});

// ---------- helpers ----------

const event = (tickets = 10) =>
  createEvent({ name: `${RUN} event ${++n}`, totalTickets: tickets, saleStartsAt: new Date(Date.now() - 60_000), pricePaise: 10_000 });
const users = (count) => createSignedInUsers(count, { prefix: `${RUN}-${++n}` });

async function api(method, path, { as, body, headers = {} } = {}) {
  const h = { ...headers };
  if (as) h.Cookie = as.cookie;
  if (body) h['Content-Type'] = 'application/json';
  const res = await fetch(`${baseUrl}${path}`, { method, headers: h, body: body && JSON.stringify(body) });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}
const hold = async (as, eventId, quantity) =>
  (await api('POST', `/api/events/${eventId}/holds`, { as, body: { quantity } })).body.hold;
const stock = async (eventId) => Number(await redis.get(stockKey(eventId)));

// Wait (up to `ms`) until check() is true — the worker runs on its own schedule.
async function eventually(check, ms = 6000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await check()) return true;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return false;
}

// ---------- the producer ----------

test('holding tickets schedules a delayed "expire-hold" job with retries and dead-letter settings', async () => {
  const e = await event();
  const [ann] = await users(1);
  const h = await hold(ann, e.id, 1);

  const job = await getQueue().getJob(`expire-hold-${h.id}`);
  assert.ok(job, 'no job was scheduled');
  assert.equal(job.name, 'expire-hold');
  assert.deepEqual(job.data, { holdId: h.id });
  assert.equal(job.opts.attempts, 5);
  assert.deepEqual(job.opts.backoff, { type: 'exponential', delay: 1000 });
  assert.equal(job.opts.removeOnFail, false, 'failed jobs must be kept (dead-letter queue)');
});

// ---------- the consumer ----------

test('an ABANDONED hold is released by the worker — nobody has to look at it', async () => {
  const e = await event(10);
  const [ann] = await users(1);
  const h = await hold(ann, e.id, 4);
  assert.equal(await stock(e.id), 6);

  // No GET, no click, no lazy expiry: only the worker can bring the tickets back.
  assert.ok(await eventually(async () => (await stock(e.id)) === 10), 'tickets were not released');
  assert.equal(await redis.exists(`hold:${h.id}`), 0);
});

test('an unpaid order is marked "expired" by the worker', async () => {
  const e = await event(10);
  const [ann] = await users(1);
  const h = await hold(ann, e.id, 2);
  const created = await api('POST', '/api/orders', {
    as: ann,
    body: { holdId: h.id },
    headers: { 'Idempotency-Key': randomUUID() },
  });
  const orderId = created.body.order.id;

  assert.ok(
    await eventually(async () => {
      const { rows } = await pool.query('SELECT status FROM orders WHERE id = $1', [orderId]);
      return rows[0].status === 'expired';
    }),
    'order was not expired',
  );
  assert.equal(await stock(e.id), 10);
});

test('a hold PAID before its time is left alone by the job (tickets stay sold)', async () => {
  const e = await event(10);
  const [ann] = await users(1);
  const h = await hold(ann, e.id, 2);
  const order = (
    await api('POST', '/api/orders', { as: ann, body: { holdId: h.id }, headers: { 'Idempotency-Key': randomUUID() } })
  ).body.order;
  await handlePaymentEvent({
    id: `${RUN}-evt-${randomUUID()}`,
    type: 'payment.succeeded',
    data: { orderId: order.id, paymentId: 'pay_test', amountPaise: order.amountPaise },
  });

  // Wait for the job to have run, then check nothing came back.
  await eventually(async () => (await (await getQueue().getJob(`expire-hold-${h.id}`))?.isCompleted()) === true);
  const job = await getQueue().getJob(`expire-hold-${h.id}`);
  assert.deepEqual(job.returnvalue, { outcome: 'already_gone' });
  assert.equal(await stock(e.id), 8, 'sold tickets must not return to stock');
});

// ---------- idempotency: "at least once" delivery ----------

test('the job is idempotent: running it again (or twice at once) returns the tickets ONCE', async () => {
  const e = await event(10);
  const [ann] = await users(1);
  const h = await hold(ann, e.id, 3);
  await redis.hset(`hold:${h.id}`, 'expiresAt', Date.now() - 1000); // already expired

  const results = await Promise.all([expireHold({ holdId: h.id }), expireHold({ holdId: h.id }), expireHold({ holdId: h.id })]);
  assert.equal(results.filter((r) => r.outcome === 'released').length, 1, JSON.stringify(results));
  assert.equal(await stock(e.id), 10);
});

test('a job that runs too EARLY fails (so BullMQ retries it later) and changes nothing', async () => {
  const e = await event(10);
  const [ann] = await users(1);
  const h = await hold(ann, e.id, 1);
  await redis.hset(`hold:${h.id}`, 'expiresAt', Date.now() + 60_000); // not expired yet

  await assert.rejects(expireHold({ holdId: h.id }), /has not expired yet/);
  assert.equal(await stock(e.id), 9);
  await redis.hset(`hold:${h.id}`, 'expiresAt', Date.now() - 1000); // let the cleanup job finish it
});

// ---------- the safety-net schedule ----------

test('the 60-second sweep is scheduled ONCE, however many workers set it up', async () => {
  const { scheduleSweep, SWEEP_EVERY_MS } = await import('../src/jobs/queue.js');
  await Promise.all([scheduleSweep(), scheduleSweep(), scheduleSweep()]); // three workers starting at once

  const schedulers = await getQueue().getJobSchedulers();
  const sweeps = schedulers.filter((s) => s.key === 'sweep-expired');
  assert.equal(sweeps.length, 1);
  assert.equal(Number(sweeps[0].every), SWEEP_EVERY_MS);
});
