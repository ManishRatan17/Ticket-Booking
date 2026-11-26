// Cancelling an event: the sale stops, unpaid orders end, every paid order is refunded, ticket holders
// are emailed, and a payment arriving afterwards is refunded too. Requires Docker.
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
import { cancelEvent } from '../src/modules/events/events.cancel.js';
import * as waitingRoom from '../src/modules/waiting-room/waiting-room.service.js';
import { queueKey } from '../src/modules/waiting-room/waiting-room.js';
import { signPayload, SIGNATURE_HEADER } from '../src/modules/payments/signature.js';
import { setMailTransport } from '../src/lib/mailer.js';
import { createSignedInUsers } from '../test-support/users.js';
import { deleteEventKeys } from '../test-support/redis-cleanup.js';
import { holdWhileCreatingAdmins } from '../test-support/admin-lock.js';

const RUN = `test-cancel-${randomUUID().slice(0, 8)}`;
let server, baseUrl, admin, releaseAdminsLock;
let n = 0;
const mails = [];

before(async () => {
  await runMigrations({ log: () => {} });
  server = createApp().listen(0);
  baseUrl = `http://localhost:${server.address().port}`;
  releaseAdminsLock = await holdWhileCreatingAdmins();
  [admin] = await createSignedInUsers(1, { prefix: `${RUN}-admin`, role: 'admin' });
  setMailTransport(async (m) => mails.push(m));
});

after(async () => {
  try {
    setMailTransport(null);
    const { rows } = await pool.query('SELECT id FROM events WHERE name LIKE $1', [`${RUN}%`]);
    const ids = rows.map((r) => r.id);
    if (ids.length) {
      await deleteEventKeys(ids);
      await pool.query('DELETE FROM sold_tickets WHERE event_id = ANY($1)', [ids]);
      await pool.query('DELETE FROM orders WHERE event_id = ANY($1)', [ids]); // refunds cascade
      await pool.query('DELETE FROM events WHERE id = ANY($1)', [ids]);
    }
    await pool.query('DELETE FROM processed_webhooks WHERE webhook_id LIKE $1', [`${RUN}%`]);
    await pool.query('DELETE FROM users WHERE email LIKE $1', [`${RUN}%`]);
  } finally {
    await releaseAdminsLock?.();
    server.close();
    await closeConnections();
  }
});

const event = (extra = {}) =>
  createEvent({ name: `${RUN} event ${++n}`, totalTickets: 50, pricePaise: 49_900, saleStartsAt: new Date(Date.now() - 60_000), ...extra });
const users = (count) => createSignedInUsers(count, { prefix: `${RUN}-${++n}` });

async function api(method, path, { as, body, headers = {} } = {}) {
  const h = { ...headers };
  if (as) h.Cookie = as.cookie;
  if (body) h['Content-Type'] = 'application/json';
  const res = await fetch(`${baseUrl}${path}`, { method, headers: h, body: body && JSON.stringify(body) });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}
const hold = async (as, eventId, quantity = 2) => (await api('POST', `/api/events/${eventId}/holds`, { as, body: { quantity } })).body.hold;
async function pendingOrder(as, eventId, quantity = 2) {
  const h = await hold(as, eventId, quantity);
  return (await api('POST', '/api/orders', { as, body: { holdId: h.id }, headers: { 'Idempotency-Key': randomUUID() } })).body.order;
}
function pay(order, paymentId = `pay_${RUN}_${randomUUID().slice(0, 8)}`) {
  const body = JSON.stringify({ id: `${RUN}-evt-${randomUUID()}`, type: 'payment.succeeded', data: { orderId: order.id, paymentId, amountPaise: order.amountPaise } });
  return fetch(`${baseUrl}/api/webhooks/payments`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', [SIGNATURE_HEADER]: signPayload(body, env.payments.webhookSecret) },
    body,
  }).then((r) => r.json());
}
const cancel = (eventId, reason = 'The venue flooded') => api('POST', `/api/admin/events/${eventId}/cancel`, { as: admin, body: { reason } });
const orderRow = async (id) => (await pool.query('SELECT status, failure_reason FROM orders WHERE id = $1', [id])).rows[0];
const refundsOf = async (orderId) => (await pool.query('SELECT * FROM refunds WHERE order_id = $1', [orderId])).rows;
// Refunds and emails happen just after the response: wait for them.
async function eventually(check) {
  for (let i = 0; i < 150; i++) {
    const value = await check();
    if (value) return value;
    await new Promise((r) => setTimeout(r, 20));
  }
  return check();
}

test('cancel → paid orders cancelled AND refunded (emailed), unpaid ones end, the sale stops', async () => {
  const e = await event();
  const [ann, bob, carol, dave] = await users(4);
  const annOrder = await pendingOrder(ann, e.id, 2);
  const bobOrder = await pendingOrder(bob, e.id, 1);
  assert.equal((await pay(annOrder)).outcome, 'paid');
  assert.equal((await pay(bobOrder)).outcome, 'paid');
  const carolOrder = await pendingOrder(carol, e.id, 1); // not paid yet
  const daveHold = await hold(dave, e.id, 1); // only a hold

  const res = await cancel(e.id);
  assert.equal(res.status, 200);
  assert.deepEqual([res.body.ordersCancelled, res.body.paidOrdersRefunded, res.body.refundTotalPaise], [3, 2, 3 * 49_900]);

  // Paid orders: cancelled, and their money goes back (processed right away: jobs are off in tests).
  for (const order of [annOrder, bobOrder]) {
    assert.deepEqual(await orderRow(order.id), { status: 'cancelled', failure_reason: 'event_cancelled' });
    const r = await eventually(async () => (await refundsOf(order.id)).find((x) => x.status === 'refunded'));
    assert.deepEqual([r.reason, r.amount_paise], ['event_cancelled', order.amountPaise]);
  }
  // The unpaid order ends; nothing to refund.
  assert.deepEqual(await orderRow(carolOrder.id), { status: 'cancelled', failure_reason: 'event_cancelled' });
  assert.equal((await refundsOf(carolOrder.id)).length, 0);

  // Ticket holders are told (Carol paid nothing: no email).
  const mail = await eventually(() => mails.find((m) => m.to === ann.email && /^Cancelled:/.test(m.subject)));
  assert.match(mail.text, /The venue flooded/);
  assert.match(mail.text, /₹998\.00/);
  assert.ok(!mails.some((m) => m.to === carol.email && /^Cancelled:/.test(m.subject)));

  // The sale is over: new holds, and orders from a hold made just before → 409 EVENT_CANCELLED.
  const [erin] = await users(1);
  const refused = await api('POST', `/api/events/${e.id}/holds`, { as: erin, body: { quantity: 1 } });
  assert.deepEqual([refused.status, refused.body.error.code, refused.body.error.details.reason], [409, 'EVENT_CANCELLED', 'The venue flooded']);
  const late = await api('POST', '/api/orders', { as: dave, body: { holdId: daveHold.id }, headers: { 'Idempotency-Key': randomUUID() } });
  assert.equal(late.body.error.code, 'EVENT_CANCELLED');

  // Everyone sees it: the shop (not on sale, with the reason), the admin (status cancelled, no revenue).
  const shop = (await api('GET', `/api/events/${e.id}`)).body.event;
  assert.deepEqual([shop.onSale, shop.cancelReason, Boolean(shop.cancelledAt)], [false, 'The venue flooded', true]);
  const adm = (await api('GET', `/api/admin/events/${e.id}`, { as: admin })).body.event;
  assert.deepEqual([adm.status, adm.revenuePaise], ['cancelled', 0]);
  // My orders shows the refund.
  const mine = (await api('GET', `/api/orders/${annOrder.id}`, { as: ann })).body.order;
  assert.deepEqual([mine.status, mine.refund.reason], ['cancelled', 'event_cancelled']);
});

test('cancel twice → 409 ALREADY_CANCELLED; unknown → 404; a short reason → 400; no edits afterwards; admins only; audited', async () => {
  const e = await event();
  const [ann] = await users(1);
  assert.equal((await api('POST', `/api/admin/events/${e.id}/cancel`, { as: ann, body: { reason: 'nope nope' } })).status, 403);
  assert.equal((await cancel(e.id, 'x')).status, 400);
  assert.equal((await cancel(e.id)).status, 200);
  assert.equal((await cancel(e.id)).body.error.code, 'ALREADY_CANCELLED');
  assert.equal((await cancel(999_999_999)).body.error.code, 'EVENT_NOT_FOUND');
  const edit = await api('PATCH', `/api/admin/events/${e.id}`, { as: admin, body: { name: `${RUN} renamed` } });
  assert.equal(edit.body.error.code, 'EVENT_CANCELLED');

  const entry = await eventually(
    async () => (await pool.query("SELECT * FROM admin_audit_log WHERE action = 'event.cancel' AND target_id = $1", [String(e.id)])).rows[0],
  );
  assert.deepEqual([entry.details.reason, entry.details.ordersCancelled], ['The venue flooded', 0]);
});

test('a payment for an order that slipped in just before the cancel → refunded, never tickets', async () => {
  const e = await event();
  const [ann] = await users(1);
  const order = await pendingOrder(ann, e.id, 2);
  await cancel(e.id);
  // As if this order had been created just AFTER the cancel locked the event's orders (so the cancel
  // didn't see it): pending on a cancelled event. Its payment must still not become tickets.
  await pool.query("UPDATE orders SET status = 'pending', failure_reason = NULL WHERE id = $1", [order.id]);

  assert.equal((await pay(order)).outcome, 'refund_needed');
  assert.deepEqual(await orderRow(order.id), { status: 'cancelled', failure_reason: 'event_cancelled' });
  const [r] = await refundsOf(order.id);
  assert.deepEqual([r.reason, r.amount_paise], ['event_cancelled', order.amountPaise]);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM sold_tickets WHERE order_id = $1', [order.id])).rows[0].n, 0);
});

// 3 rounds: the timing differs each time. (With the cancel locking the EVENT first, the opposite order
// to payments, PostgreSQL reported "deadlock detected" in 6 of 8 single rounds.)
test('RACE: 8 payments and the cancel at the same moment → no order stays paid, every payment refunded once, no deadlock', async () => {
  for (let round = 1; round <= 3; round++) {
    const e = await event();
    const people = await users(8);
    const orders = [];
    for (const p of people) orders.push(await pendingOrder(p, e.id, 1));

    // allSettled: even if the cancel fails (a deadlock), wait for every payment to finish before checking,
    // so nothing is still writing when the cleanup runs.
    const [payments, cancelling] = await Promise.allSettled([
      Promise.all(orders.map((o) => pay(o))),
      (async () => {
        await new Promise((r) => setTimeout(r, 5)); // let a few payments start first
        return cancelEvent({ eventId: e.id, reason: 'Storm warning' });
      })(),
    ]);
    if (cancelling.status === 'rejected') throw cancelling.reason; // e.g. "deadlock detected"
    const results = payments.value;
    assert.ok(results.every((r) => ['paid', 'refund_needed'].includes(r.outcome)), JSON.stringify(results));
    assert.equal(cancelling.value.ordersCancelled, 8);

    for (const o of orders) {
      assert.equal((await orderRow(o.id)).status, 'cancelled', `round ${round}, order ${o.id}`);
      const refunds = await refundsOf(o.id);
      assert.equal(refunds.length, 1, `round ${round}, order ${o.id}: exactly one refund`);
      assert.equal(refunds[0].reason, 'event_cancelled');
    }
  }
});

test('the waiting room closes: joining or watching → 409 EVENT_CANCELLED, the line is gone', async () => {
  const e = await event({ admissionPerSecond: 5, saleStartsAt: new Date(Date.now() + 5 * 60_000) });
  const [ann] = await users(1);
  await waitingRoom.join({ eventId: e.id, userId: ann.id });
  assert.equal(await redis.zcard(queueKey(e.id)), 1);

  await cancel(e.id);
  assert.equal(await redis.zcard(queueKey(e.id)), 0);
  await assert.rejects(waitingRoom.getStatus({ eventId: e.id, userId: ann.id }), { code: 'EVENT_CANCELLED' });
  await assert.rejects(waitingRoom.join({ eventId: e.id, userId: ann.id }), { code: 'EVENT_CANCELLED' });
});
