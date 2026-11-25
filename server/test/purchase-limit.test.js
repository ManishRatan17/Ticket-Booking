// Phase 5b: at most 4 tickets per person per event, over ALL their orders. Requires Docker.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createApp } from '../src/app.js';
import { env } from '../src/config/env.js';
import { pool } from '../src/config/db.js';
import { redis } from '../src/config/redis.js';
import { runMigrations } from '../src/db/migrate.js';
import { closeConnections } from '../src/config/connections.js';
import { createEvent } from '../src/modules/events/events.service.js';
import { releaseHold } from '../src/modules/reservation/holds.js';
import { stockKey } from '../src/modules/reservation/stock.js';
import { signPayload, SIGNATURE_HEADER } from '../src/modules/payments/signature.js';
import { createSignedInUsers } from '../test-support/users.js';
import { deleteEventKeys } from '../test-support/redis-cleanup.js';

const RUN = `test-cap-${randomUUID().slice(0, 8)}`;
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

// ---------- helpers ----------

const event = (tickets = 100) =>
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

const hold = (as, eventId, quantity) => api('POST', `/api/events/${eventId}/holds`, { as, body: { quantity } });
const order = async (as, holdId) =>
  (await api('POST', '/api/orders', { as, body: { holdId }, headers: { 'Idempotency-Key': randomUUID() } })).body.order;

// Pays straight through the signed webhook (as the provider would), and returns the result.
async function pay(o) {
  const body = {
    id: `${RUN}-evt-${randomUUID()}`,
    type: 'payment.succeeded',
    data: { orderId: o.id, paymentId: `pay_${randomUUID()}`, amountPaise: o.amountPaise },
  };
  const res = await fetch(`${baseUrl}/api/webhooks/payments`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', [SIGNATURE_HEADER]: signPayload(JSON.stringify(body), env.payments.webhookSecret) },
    body: JSON.stringify(body),
  });
  return res.json();
}

// hold → order → paid. Returns the paid order's webhook result.
async function buy(as, eventId, quantity) {
  const h = await hold(as, eventId, quantity);
  assert.equal(h.status, 201, `hold ${quantity}: ${JSON.stringify(h.body)}`);
  return pay(await order(as, h.body.hold.id));
}

const paidTickets = async (eventId, userId) =>
  (
    await pool.query(
      `SELECT COALESCE(SUM(quantity), 0)::int AS n FROM orders WHERE event_id = $1 AND user_id = $2 AND status = 'paid'`,
      [eventId, userId],
    )
  ).rows[0].n;

// ---------- the cap ----------

test('bought 4 → holding even 1 more → 409 PURCHASE_LIMIT (bought 4, limit 4)', async () => {
  const e = await event();
  const [ann] = await users(1);
  assert.equal((await buy(ann, e.id, 4)).outcome, 'paid');

  const res = await hold(ann, e.id, 1);
  assert.equal(res.status, 409);
  assert.equal(res.body.error.code, 'PURCHASE_LIMIT');
  assert.deepEqual(res.body.error.details, { bought: 4, limit: 4 });
});

test('bought 2 → 3 more is refused, 2 more is fine; the refusal changes nothing', async () => {
  const e = await event(100);
  const [ann] = await users(1);
  await buy(ann, e.id, 2);
  const stockBefore = Number(await redis.get(stockKey(e.id)));

  assert.equal((await hold(ann, e.id, 3)).body.error.code, 'PURCHASE_LIMIT');
  assert.equal(Number(await redis.get(stockKey(e.id))), stockBefore, 'a refused hold takes no stock');

  assert.equal((await buy(ann, e.id, 2)).outcome, 'paid');
  assert.equal(await paidTickets(e.id, ann.id), 4);
});

test('the limit is per person AND per event', async () => {
  const [e1, e2] = [await event(), await event()];
  const [ann, bob] = await users(2);
  await buy(ann, e1.id, 4);
  assert.equal((await hold(bob, e1.id, 4)).status, 201, 'another person, same event');
  assert.equal((await hold(ann, e2.id, 4)).status, 201, 'same person, another event');
});

test('a FAILED payment does not count', async () => {
  const e = await event();
  const [ann] = await users(1);
  const h = await hold(ann, e.id, 4);
  const o = await order(ann, h.body.hold.id);
  const failed = await fetch(`${baseUrl}/api/payments/fake/${o.id}`, {
    method: 'POST',
    headers: { Cookie: ann.cookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ outcome: 'failure' }),
  });
  assert.equal(failed.status, 202);
  for (let i = 0; i < 100 && (await pool.query('SELECT status FROM orders WHERE id = $1', [o.id])).rows[0].status === 'pending'; i++) {
    await new Promise((r) => setTimeout(r, 25));
  }
  assert.equal((await hold(ann, e.id, 4)).status, 201);
});

test('the event page gets { bought, limit } with my hold', async () => {
  const e = await event();
  const [ann] = await users(1);
  assert.deepEqual((await api('GET', `/api/events/${e.id}/holds/mine`, { as: ann })).body.purchase, { bought: 0, limit: 4 });
  await buy(ann, e.id, 3);
  assert.deepEqual((await api('GET', `/api/events/${e.id}/holds/mine`, { as: ann })).body.purchase, { bought: 3, limit: 4 });
});

// ---------- Redis is the fast copy, PostgreSQL the truth ----------

test('Redis lost the count → rebuilt from paid orders in PostgreSQL', async () => {
  const e = await event();
  const [ann] = await users(1);
  await buy(ann, e.id, 3);
  await redis.del(`event:${e.id}:user:${ann.id}:bought`); // as if Redis restarted without its data

  assert.equal((await hold(ann, e.id, 2)).body.error?.code, 'PURCHASE_LIMIT');
  assert.equal(await redis.get(`event:${e.id}:user:${ann.id}:bought`), '3');
  assert.equal((await hold(ann, e.id, 1)).status, 201);
});

test('two orders paid AT THE SAME TIME (an old late one + a new one): PostgreSQL lets only 4 tickets through', async () => {
  const e = await event();
  const [ann] = await users(1);

  // Order A: hold 4 → order → the hold is released (as if it expired), order A still pending.
  const a = await order(ann, (await hold(ann, e.id, 4)).body.hold.id);
  await releaseHold((await pool.query('SELECT hold_id FROM orders WHERE id = $1', [a.id])).rows[0].hold_id);
  // Order B: a new hold of 4 → order. Redis allowed it: nothing was BOUGHT yet.
  const b = await order(ann, (await hold(ann, e.id, 4)).body.hold.id);

  const results = await Promise.all([pay(a), pay(b)]);
  const outcomes = results.map((r) => r.outcome).sort();
  assert.deepEqual(outcomes, ['paid', 'refund_needed'], JSON.stringify(results));
  assert.equal(await paidTickets(e.id, ann.id), 4, 'never more than 4 paid tickets');

  const failed = await pool.query(`SELECT failure_reason FROM orders WHERE id = ANY($1) AND status = 'failed'`, [[a.id, b.id]]);
  assert.equal(failed.rows[0].failure_reason, 'purchase_limit');
  assert.equal(await redis.get(`event:${e.id}:user:${ann.id}:bought`), '4');
});
