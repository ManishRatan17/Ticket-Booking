// The safety-net sweep and the expiry index. Requires Docker.
// Jobs stay OFF here (.env.test): holds get NO per-hold job — exactly the "missed job" case.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createApp } from '../src/app.js';
import { pool } from '../src/config/db.js';
import { redis } from '../src/config/redis.js';
import { runMigrations } from '../src/db/migrate.js';
import { closeConnections } from '../src/config/connections.js';
import { stockKey } from '../src/modules/reservation/stock.js';
import { HOLDS_BY_EXPIRY, indexAllHolds } from '../src/modules/reservation/holds.js';
import { createEvent } from '../src/modules/events/events.service.js';
import { handlePaymentEvent } from '../src/modules/payments/payments.service.js';
import { sweepExpired } from '../src/jobs/processors.js';
import { createSignedInUsers } from '../test-support/users.js';
import { deleteEventKeys } from '../test-support/redis-cleanup.js';


const RUN = `test-sweep-${randomUUID().slice(0, 8)}`;
let server, baseUrl;
let n = 0;

before(async () => {
  await runMigrations({ log: () => {} });
  server = createApp().listen(0);
  baseUrl = `http://localhost:${server.address().port}`;
});

after(async () => {
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
const indexScore = (holdId) => redis.zscore(HOLDS_BY_EXPIRY, holdId);

// Pretend the hold's time ran out a while ago: move it in the hold AND in the index.
async function backdate(holdId) {
  const past = Date.now() - 60_000;
  await redis.hset(`hold:${holdId}`, 'expiresAt', past);
  await redis.zadd(HOLDS_BY_EXPIRY, past, holdId);
}

// ---------- the index stays in step with the holds (maintained inside the Lua scripts) ----------

test('index: a new hold is added with its expiry; releasing removes it', async () => {
  const e = await event();
  const [ann] = await users(1);
  const h = await hold(ann, e.id, 1);
  assert.equal(Number(await indexScore(h.id)), new Date(h.expiresAt).getTime());

  await api('DELETE', `/api/holds/${h.id}`, { as: ann });
  assert.equal(await indexScore(h.id), null);
});

test('index: a PAID (consumed) hold is removed too', async () => {
  const e = await event();
  const [ann] = await users(1);
  const h = await hold(ann, e.id, 1);
  const order = (await api('POST', '/api/orders', { as: ann, body: { holdId: h.id }, headers: { 'Idempotency-Key': randomUUID() } }))
    .body.order;
  await handlePaymentEvent({
    id: `${RUN}-evt-${randomUUID()}`,
    type: 'payment.succeeded',
    data: { orderId: order.id, paymentId: 'pay_test', amountPaise: order.amountPaise },
  });
  assert.equal(await indexScore(h.id), null);
});

test('index: holds that are missing from it are added back by indexAllHolds()', async () => {
  const e = await event();
  const [ann] = await users(1);
  const h = await hold(ann, e.id, 1);
  await redis.zrem(HOLDS_BY_EXPIRY, h.id); // e.g. a hold made before the index existed

  assert.ok((await indexAllHolds()) >= 1);
  assert.equal(Number(await indexScore(h.id)), new Date(h.expiresAt).getTime());
});

// ---------- the sweep ----------

test('sweep: an expired hold that NEVER got a job is released', async () => {
  const e = await event(10);
  const [ann] = await users(1);
  const h = await hold(ann, e.id, 3);
  await backdate(h.id);

  const result = await sweepExpired();
  assert.ok(result.holdsReleased >= 1);
  assert.equal(await stock(e.id), 10);
  assert.equal(await indexScore(h.id), null);
});

test('sweep: a hold that is still running is left alone', async () => {
  const e = await event(10);
  const [ann] = await users(1);
  await hold(ann, e.id, 2);
  await sweepExpired();
  assert.equal(await stock(e.id), 8);
});

test('sweep: an overdue pending order whose hold vanished (Redis lost it) is expired', async () => {
  const e = await event(10);
  const [ann] = await users(1);
  const h = await hold(ann, e.id, 2);
  const order = (await api('POST', '/api/orders', { as: ann, body: { holdId: h.id }, headers: { 'Idempotency-Key': randomUUID() } }))
    .body.order;
  await redis.del(`hold:${h.id}`); // the hold is gone without anyone expiring the order
  await redis.zrem(HOLDS_BY_EXPIRY, h.id);
  await pool.query(`UPDATE orders SET expires_at = now() - interval '1 minute' WHERE id = $1`, [order.id]);

  assert.ok((await sweepExpired()).ordersExpired >= 1);
  const { rows } = await pool.query('SELECT status FROM orders WHERE id = $1', [order.id]);
  assert.equal(rows[0].status, 'expired');
});

test('sweep: a stale index entry (hold already gone) is cleaned up', async () => {
  const ghost = randomUUID();
  await redis.zadd(HOLDS_BY_EXPIRY, Date.now() - 60_000, ghost);
  const result = await sweepExpired();
  assert.ok(result.staleEntries >= 1);
  assert.equal(await indexScore(ghost), null);
});

test('sweep: running it twice at once releases each hold once', async () => {
  const e = await event(10);
  const [ann, bob] = await users(2);
  const h1 = await hold(ann, e.id, 3);
  const h2 = await hold(bob, e.id, 4);
  await backdate(h1.id);
  await backdate(h2.id);

  await Promise.all([sweepExpired(), sweepExpired()]);
  assert.equal(await stock(e.id), 10, 'not 17');
});
