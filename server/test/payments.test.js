// Payments: fake provider → signed webhook → paid order with ticket numbers. Requires Docker.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createApp } from '../src/app.js';
import { env } from '../src/config/env.js';
import { pool } from '../src/config/db.js';
import { redis } from '../src/config/redis.js';
import { runMigrations } from '../src/db/migrate.js';
import { closeConnections } from '../src/config/connections.js';
import { stockKey } from '../src/modules/reservation/stock.js';
import { createEvent } from '../src/modules/events/events.service.js';
import { signPayload, SIGNATURE_HEADER } from '../src/modules/payments/signature.js';
import { createSignedInUsers } from '../test-support/users.js';

const RUN = `test-payments-${randomUUID().slice(0, 8)}`;
let server, baseUrl;
let n = 0;

before(async () => {
  await runMigrations({ log: () => {} });
  server = createApp().listen(0);
  baseUrl = `http://localhost:${server.address().port}`;
});

after(async () => {
  await new Promise((resolve) => setTimeout(resolve, 300)); // let late fake deliveries finish
  const { rows } = await pool.query('SELECT id FROM events WHERE name LIKE $1', [`${RUN}%`]);
  const ids = rows.map((r) => r.id);
  if (ids.length) {
    const keys = [];
    for await (const batch of redis.scanStream({ match: 'hold:*', count: 1000 })) {
      for (const key of batch) if (ids.map(String).includes(await redis.hget(key, 'eventId'))) keys.push(key);
    }
    for (const id of ids) {
      for await (const batch of redis.scanStream({ match: `event:${id}:*`, count: 1000 })) keys.push(...batch);
    }
    if (keys.length) await redis.del(...keys);
    await pool.query('DELETE FROM sold_tickets WHERE event_id = ANY($1)', [ids]);
    await pool.query('DELETE FROM orders WHERE event_id = ANY($1)', [ids]);
    await pool.query('DELETE FROM events WHERE id = ANY($1)', [ids]);
  }
  await pool.query(`DELETE FROM processed_webhooks WHERE webhook_id LIKE $1`, [`${RUN}%`]);
  await pool.query('DELETE FROM users WHERE email LIKE $1', [`${RUN}%`]);
  server.close();
  await closeConnections();
});

// ---------- helpers ----------

const event = (tickets = 10, pricePaise = 49_900) =>
  createEvent({ name: `${RUN} event ${++n}`, totalTickets: tickets, saleStartsAt: new Date(Date.now() - 60_000), pricePaise });
const users = (count) => createSignedInUsers(count, { prefix: `${RUN}-${++n}` });

async function api(method, path, { as, body, headers = {} } = {}) {
  const h = { ...headers };
  if (as) h.Cookie = as.cookie;
  if (body) h['Content-Type'] = 'application/json';
  const res = await fetch(`${baseUrl}${path}`, { method, headers: h, body: body && JSON.stringify(body) });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

// hold → order. Returns the pending order.
async function pendingOrder(as, eventId, quantity = 2) {
  const hold = (await api('POST', `/api/events/${eventId}/holds`, { as, body: { quantity } })).body.hold;
  return (await api('POST', '/api/orders', { as, body: { holdId: hold.id }, headers: { 'Idempotency-Key': randomUUID() } }))
    .body.order;
}

const getOrder = async (as, id) => (await api('GET', `/api/orders/${id}`, { as })).body.order;

// The webhook arrives a little later: wait until the order leaves 'pending'.
async function waitForSettled(as, id, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const order = await getOrder(as, id);
    if (order.status !== 'pending' || Date.now() > deadline) return order;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

// Sends a webhook exactly like the provider would (signed with the shared secret).
function webhook(eventBody, { secret = env.payments.webhookSecret, rawOverride } = {}) {
  const raw = rawOverride ?? JSON.stringify(eventBody);
  return fetch(`${baseUrl}/api/webhooks/payments`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', [SIGNATURE_HEADER]: signPayload(JSON.stringify(eventBody), secret) },
    body: raw,
  }).then(async (res) => ({ status: res.status, body: await res.json() }));
}
const succeeded = (order, id = `${RUN}-evt-${randomUUID()}`) => ({
  id,
  type: 'payment.succeeded',
  data: { orderId: order.id, paymentId: `pay_${randomUUID()}`, amountPaise: order.amountPaise },
});

const stock = async (eventId) => Number(await redis.get(stockKey(eventId)));
const ticketsSold = async (eventId) =>
  (await pool.query('SELECT tickets_sold FROM events WHERE id = $1', [eventId])).rows[0].tickets_sold;

// ---------- the happy path, end to end ----------

test('pay → provider calls the signed webhook → paid, ticket numbers 1 and 2, hold consumed', async () => {
  const e = await event(10);
  const [ann] = await users(1);
  const order = await pendingOrder(ann, e.id, 2);

  const start = await api('POST', `/api/payments/fake/${order.id}`, { as: ann, body: { outcome: 'success' } });
  assert.equal(start.status, 202);

  const paid = await waitForSettled(ann, order.id);
  assert.equal(paid.status, 'paid');
  assert.deepEqual(paid.ticketNumbers, [1, 2]);
  assert.ok(paid.paidAt);

  assert.equal(await stock(e.id), 8, 'the 2 sold tickets must NOT come back to stock');
  assert.equal(await ticketsSold(e.id), 2);
  assert.equal((await api('GET', `/api/events/${e.id}/holds/mine`, { as: ann })).body.hold, null, 'hold consumed');
});

test('failed payment → order failed, its held tickets back on sale', async () => {
  const e = await event(10);
  const [ann] = await users(1);
  const order = await pendingOrder(ann, e.id, 3);
  assert.equal(await stock(e.id), 7);

  await api('POST', `/api/payments/fake/${order.id}`, { as: ann, body: { outcome: 'failure' } });
  const failed = await waitForSettled(ann, order.id);
  assert.equal(failed.status, 'failed');
  assert.equal(failed.failureReason, 'payment_failed');
  assert.equal(await stock(e.id), 10);
});

// ---------- the browser can't decide payment ----------

test('starting a payment: not yours → 404; already paid → 409; not signed in → 401', async () => {
  const e = await event(10);
  const [ann, bob] = await users(2);
  const order = await pendingOrder(ann, e.id);
  assert.equal((await api('POST', `/api/payments/fake/${order.id}`, { as: bob, body: { outcome: 'success' } })).status, 404);
  assert.equal((await api('POST', `/api/payments/fake/${order.id}`, { body: { outcome: 'success' } })).status, 401);

  await webhook(succeeded(order));
  const again = await api('POST', `/api/payments/fake/${order.id}`, { as: ann, body: { outcome: 'success' } });
  assert.equal(again.status, 409);
  assert.equal(again.body.error.code, 'ORDER_NOT_PENDING');
});

// ---------- signatures ----------

test('webhook with a wrong secret → 401, nothing changes', async () => {
  const e = await event(10);
  const [ann] = await users(1);
  const order = await pendingOrder(ann, e.id);

  const res = await webhook(succeeded(order), { secret: 'x'.repeat(64) });
  assert.equal(res.status, 401);
  assert.equal(res.body.error.code, 'INVALID_SIGNATURE');
  assert.equal((await getOrder(ann, order.id)).status, 'pending');
});

test('webhook body changed after signing (amount lowered) → 401', async () => {
  const e = await event(10);
  const [ann] = await users(1);
  const order = await pendingOrder(ann, e.id);
  const genuine = succeeded(order);
  const tampered = JSON.stringify({ ...genuine, data: { ...genuine.data, amountPaise: 1 } });

  const res = await webhook(genuine, { rawOverride: tampered }); // signature of the genuine body
  assert.equal(res.status, 401);
});

// ---------- idempotency ----------

test('the SAME webhook delivered twice → processed once', async () => {
  const e = await event(10);
  const [ann] = await users(1);
  const order = await pendingOrder(ann, e.id, 2);
  const delivery = succeeded(order);

  assert.equal((await webhook(delivery)).body.outcome, 'paid');
  assert.equal((await webhook(delivery)).body.outcome, 'duplicate');
  assert.equal(await ticketsSold(e.id), 2, 'not 4');
  assert.deepEqual((await getOrder(ann, order.id)).ticketNumbers, [1, 2]);
});

test('race: the same webhook delivered 10 times at once → paid once', async () => {
  const e = await event(10);
  const [ann] = await users(1);
  const order = await pendingOrder(ann, e.id, 2);
  const delivery = succeeded(order);

  const outcomes = (await Promise.all(Array.from({ length: 10 }, () => webhook(delivery)))).map((r) => r.body.outcome);
  assert.equal(outcomes.filter((o) => o === 'paid').length, 1, `outcomes: ${outcomes}`);
  assert.equal(await ticketsSold(e.id), 2);
});

test('two DIFFERENT deliveries for one order (provider retried with a new id) → paid once', async () => {
  const e = await event(10);
  const [ann] = await users(1);
  const order = await pendingOrder(ann, e.id, 2);
  const results = await Promise.all([webhook(succeeded(order)), webhook(succeeded(order))]);

  assert.deepEqual(results.map((r) => r.body.outcome).sort(), ['already_paid', 'paid']);
  assert.equal(await ticketsSold(e.id), 2);
});

test('amount in the webhook differs from the order → failed, not paid', async () => {
  const e = await event(10);
  const [ann] = await users(1);
  const order = await pendingOrder(ann, e.id, 2);
  const wrong = succeeded(order);
  wrong.data.amountPaise = order.amountPaise - 1;

  assert.equal((await webhook(wrong)).body.outcome, 'failed');
  const after = await getOrder(ann, order.id);
  assert.equal(after.status, 'failed');
  assert.equal(after.failureReason, 'amount_mismatch');
  assert.equal(await stock(e.id), 10);
});

// ---------- late payments ----------

test('late payment, tickets still available → confirmed anyway', async () => {
  const e = await event(10);
  const [ann] = await users(1);
  const order = await pendingOrder(ann, e.id, 2);
  // The deadline passes and someone looks at the order: expired, hold released, tickets back.
  await pool.query(`UPDATE orders SET expires_at = now() - interval '1 second' WHERE id = $1`, [order.id]);
  assert.equal((await getOrder(ann, order.id)).status, 'expired');
  assert.equal(await stock(e.id), 10);

  assert.equal((await webhook(succeeded(order))).body.outcome, 'paid');
  const paid = await getOrder(ann, order.id);
  assert.equal(paid.status, 'paid');
  assert.equal(await stock(e.id), 8, 'the tickets were taken from stock again');
});

test('late payment, but sold out meanwhile → failed + refund needed; the other buyer unaffected', async () => {
  const e = await event(2);
  const [ann, bob] = await users(2);
  const annOrder = await pendingOrder(ann, e.id, 2);
  await pool.query(`UPDATE orders SET expires_at = now() - interval '1 second' WHERE id = $1`, [annOrder.id]);
  await getOrder(ann, annOrder.id); // expires, tickets back on sale…
  await pendingOrder(bob, e.id, 2); // …and Bob holds them

  assert.equal((await webhook(succeeded(annOrder))).body.outcome, 'refund_needed');
  const annAfter = await getOrder(ann, annOrder.id);
  assert.equal(annAfter.status, 'failed');
  assert.equal(annAfter.failureReason, 'sold_out_after_expiry');
  assert.equal(await ticketsSold(e.id), 0);
  assert.equal(await stock(e.id), 0, "Bob's hold still has the tickets");
});

// ---------- concurrency: many payments at once ----------

test('20 buyers pay at the same moment → ticket numbers 1–20, each exactly once', async () => {
  const e = await event(20);
  const crowd = await users(20);
  const orders = await Promise.all(crowd.map((u) => pendingOrder(u, e.id, 1)));

  const outcomes = await Promise.all(orders.map((o) => webhook(succeeded(o))));
  assert.ok(outcomes.every((r) => r.body.outcome === 'paid'));

  const { rows } = await pool.query(
    'SELECT ticket_number FROM sold_tickets WHERE event_id = $1 ORDER BY ticket_number',
    [e.id],
  );
  assert.deepEqual(rows.map((r) => r.ticket_number), Array.from({ length: 20 }, (_, i) => i + 1));
  assert.equal(await ticketsSold(e.id), 20);
  assert.equal(await stock(e.id), 0);
});

test('webhook for an unknown order → 200 "unknown_order" (acknowledged, nothing to do)', async () => {
  const res = await webhook({
    id: `${RUN}-evt-${randomUUID()}`,
    type: 'payment.succeeded',
    data: { orderId: 999999999, paymentId: 'pay_x', amountPaise: 1 },
  });
  assert.equal(res.status, 200);
  assert.equal(res.body.outcome, 'unknown_order');
});
