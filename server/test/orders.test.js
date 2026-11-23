// Orders: holds become pending orders, safely retryable (idempotency). Requires Docker.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createApp } from '../src/app.js';
import { pool } from '../src/config/db.js';
import { redis } from '../src/config/redis.js';
import { runMigrations } from '../src/db/migrate.js';
import { closeConnections } from '../src/config/connections.js';
import { stockKey } from '../src/modules/reservation/stock.js';
import { createEvent } from '../src/modules/events/events.service.js';
import { createSignedInUsers } from '../test-support/users.js';
import { deleteEventKeys } from '../test-support/redis-cleanup.js';


const RUN = `test-orders-${randomUUID().slice(0, 8)}`;
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
  await pool.query('DELETE FROM users WHERE email LIKE $1', [`${RUN}%`]);
  server.close();
  await closeConnections();
});

const event = (tickets = 10, pricePaise = 49_900) =>
  createEvent({ name: `${RUN} event ${++n}`, totalTickets: tickets, saleStartsAt: new Date(Date.now() - 60_000), pricePaise });
const users = (count) => createSignedInUsers(count, { prefix: `${RUN}-${++n}` });

async function api(method, path, { as, body, headers = {} } = {}) {
  const h = { ...headers };
  if (as) h.Cookie = as.cookie;
  if (body) h['Content-Type'] = 'application/json';
  const res = await fetch(`${baseUrl}${path}`, { method, headers: h, body: body && JSON.stringify(body) });
  const text = await res.text();
  return { status: res.status, headers: res.headers, body: text ? JSON.parse(text) : null };
}

const hold = async (as, eventId, quantity = 2) =>
  (await api('POST', `/api/events/${eventId}/holds`, { as, body: { quantity } })).body.hold;
const order = (as, holdId, key = randomUUID()) =>
  api('POST', '/api/orders', { as, body: { holdId }, headers: { 'Idempotency-Key': key } });
const stock = async (eventId) => Number(await redis.get(stockKey(eventId)));

// ---------- creating ----------

test('a hold becomes a pending order: price from the database, same deadline as the hold', async () => {
  const e = await event(10, 49_900);
  const [ann] = await users(1);
  const h = await hold(ann, e.id, 3);

  const res = await order(ann, h.id);
  assert.equal(res.status, 201);
  assert.equal(res.body.order.status, 'pending');
  assert.equal(res.body.order.quantity, 3);
  assert.equal(res.body.order.amountPaise, 3 * 49_900);
  assert.equal(res.body.order.expiresAt, h.expiresAt);
  assert.deepEqual(res.body.order.ticketNumbers, []);
  assert.ok(res.body.serverTime);
  assert.equal(await stock(e.id), 7, 'tickets stay held, not returned');
});

test('the client cannot set the price: an "amountPaise" in the body is ignored', async () => {
  const e = await event(10, 49_900);
  const [ann] = await users(1);
  const h = await hold(ann, e.id, 1);
  const res = await api('POST', '/api/orders', {
    as: ann,
    body: { holdId: h.id, amountPaise: 1 },
    headers: { 'Idempotency-Key': randomUUID() },
  });
  assert.equal(res.body.order.amountPaise, 49_900);
});

// ---------- idempotency ----------

test('same Idempotency-Key again → the SAME order (200, Idempotent-Replayed)', async () => {
  const e = await event();
  const [ann] = await users(1);
  const h = await hold(ann, e.id);
  const key = randomUUID();

  const first = await order(ann, h.id, key);
  const retry = await order(ann, h.id, key);
  assert.equal(first.status, 201);
  assert.equal(retry.status, 200);
  assert.equal(retry.headers.get('idempotent-replayed'), 'true');
  assert.equal(retry.body.order.id, first.body.order.id);
});

test('race: 10 parallel requests with one key → exactly one order in the database', async () => {
  const e = await event();
  const [ann] = await users(1);
  const h = await hold(ann, e.id);
  const key = randomUUID();

  const results = await Promise.all(Array.from({ length: 10 }, () => order(ann, h.id, key)));
  assert.equal(new Set(results.map((r) => r.body.order.id)).size, 1, 'everyone got the same order');
  assert.equal(results.filter((r) => r.status === 201).length, 1, 'exactly one request created it');

  const { rows } = await pool.query('SELECT count(*)::int AS n FROM orders WHERE hold_id = $1', [h.id]);
  assert.equal(rows[0].n, 1);
});

test('a DIFFERENT key for a hold that already has an order → 409 ORDER_EXISTS with its id', async () => {
  const e = await event();
  const [ann] = await users(1);
  const h = await hold(ann, e.id);
  const first = await order(ann, h.id);
  const second = await order(ann, h.id);
  assert.equal(second.status, 409);
  assert.equal(second.body.error.code, 'ORDER_EXISTS');
  assert.equal(second.body.error.details.orderId, first.body.order.id);
});

test('the same key for a DIFFERENT hold → 422 IDEMPOTENCY_KEY_REUSED', async () => {
  const [ann] = await users(1);
  const key = randomUUID();
  const h1 = await hold(ann, (await event()).id);
  const h2 = await hold(ann, (await event()).id);
  await order(ann, h1.id, key);
  const res = await order(ann, h2.id, key);
  assert.equal(res.status, 422);
  assert.equal(res.body.error.code, 'IDEMPOTENCY_KEY_REUSED');
});

test('missing or malformed Idempotency-Key → 400', async () => {
  const [ann] = await users(1);
  const h = await hold(ann, (await event()).id);
  const none = await api('POST', '/api/orders', { as: ann, body: { holdId: h.id } });
  assert.equal(none.status, 400);
  assert.equal(none.body.error.code, 'IDEMPOTENCY_KEY_REQUIRED');
  assert.equal((await order(ann, h.id, 'short')).status, 400);
});

// ---------- whose hold, which state ----------

test('someone else\'s hold → 404; an expired hold → 409 HOLD_EXPIRED', async () => {
  const e = await event();
  const [ann, bob] = await users(2);
  const h = await hold(ann, e.id);
  assert.equal((await order(bob, h.id)).status, 404);

  await redis.hset(`hold:${h.id}`, 'expiresAt', Date.now() - 1000);
  const res = await order(ann, h.id);
  assert.equal(res.status, 409);
  assert.equal(res.body.error.code, 'HOLD_EXPIRED');
});

test('not signed in → 401', async () => {
  assert.equal((await api('POST', '/api/orders', { body: { holdId: randomUUID() } })).status, 401);
});

// ---------- reading ----------

test('GET an order: yours → 200; someone else\'s → 404 (IDOR); list shows yours', async () => {
  const e = await event();
  const [ann, bob] = await users(2);
  const created = (await order(ann, (await hold(ann, e.id)).id)).body.order;

  assert.equal((await api('GET', `/api/orders/${created.id}`, { as: ann })).status, 200);
  assert.equal((await api('GET', `/api/orders/${created.id}`, { as: bob })).status, 404);

  const list = await api('GET', '/api/orders', { as: ann });
  assert.deepEqual(list.body.orders.map((o) => o.id), [created.id]);
  assert.equal((await api('GET', '/api/orders', { as: bob })).body.orders.length, 0);
});

test('lazy expiry: an unpaid order past its deadline becomes "expired" and its tickets return', async () => {
  const e = await event(10);
  const [ann] = await users(1);
  const h = await hold(ann, e.id, 4);
  const created = (await order(ann, h.id)).body.order;
  assert.equal(await stock(e.id), 6);

  await pool.query(`UPDATE orders SET expires_at = now() - interval '1 second' WHERE id = $1`, [created.id]);
  const res = await api('GET', `/api/orders/${created.id}`, { as: ann });
  assert.equal(res.body.order.status, 'expired');
  assert.equal(await stock(e.id), 10, 'the 4 held tickets are back on sale');
});

// ---------- the database's own oversell guard ----------

test('the database refuses to number more tickets than exist (CHECK tickets_sold <= total)', async () => {
  const e = await event(3);
  await assert.rejects(
    pool.query('UPDATE events SET tickets_sold = tickets_sold + 4 WHERE id = $1', [e.id]),
    { constraint: 'events_tickets_sold_within_total' },
  );
});
