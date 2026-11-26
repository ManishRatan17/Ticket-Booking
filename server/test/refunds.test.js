// Refunds: money that bought no tickets goes back (fake provider here; Razorpay refunds are in
// razorpay.test.js). Background jobs are off in tests, so refunds are processed right away. Requires Docker.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createApp } from '../src/app.js';
import { env } from '../src/config/env.js';
import { pool } from '../src/config/db.js';
import { runMigrations } from '../src/db/migrate.js';
import { closeConnections } from '../src/config/connections.js';
import { createEvent } from '../src/modules/events/events.service.js';
import { signPayload, SIGNATURE_HEADER } from '../src/modules/payments/signature.js';
import { setMailTransport } from '../src/lib/mailer.js';
import { createSignedInUsers } from '../test-support/users.js';
import { deleteEventKeys } from '../test-support/redis-cleanup.js';
import { holdWhileCreatingAdmins } from '../test-support/admin-lock.js';

const RUN = `test-refunds-${randomUUID().slice(0, 8)}`;
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

const event = (tickets = 10) =>
  createEvent({ name: `${RUN} event ${++n}`, totalTickets: tickets, pricePaise: 49_900, saleStartsAt: new Date(Date.now() - 60_000) });
const users = (count) => createSignedInUsers(count, { prefix: `${RUN}-${++n}` });

async function api(method, path, { as, body, headers = {} } = {}) {
  const h = { ...headers };
  if (as) h.Cookie = as.cookie;
  if (body) h['Content-Type'] = 'application/json';
  const res = await fetch(`${baseUrl}${path}`, { method, headers: h, body: body && JSON.stringify(body) });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}
async function pendingOrder(as, eventId, quantity = 2) {
  const hold = (await api('POST', `/api/events/${eventId}/holds`, { as, body: { quantity } })).body.hold;
  return (await api('POST', '/api/orders', { as, body: { holdId: hold.id }, headers: { 'Idempotency-Key': randomUUID() } })).body.order;
}
function webhook(order, { paymentId = `pay_${randomUUID()}`, amountPaise = order.amountPaise, id = `${RUN}-evt-${randomUUID()}` } = {}) {
  const body = JSON.stringify({ id, type: 'payment.succeeded', data: { orderId: order.id, paymentId, amountPaise } });
  return fetch(`${baseUrl}/api/webhooks/payments`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', [SIGNATURE_HEADER]: signPayload(body, env.payments.webhookSecret) },
    body,
  }).then((r) => r.json());
}
const refundsOf = async (orderId) => (await pool.query('SELECT * FROM refunds WHERE order_id = $1 ORDER BY id', [orderId])).rows;
async function waitForRefunded(orderId) {
  for (let i = 0; i < 100; i++) {
    const [r] = await refundsOf(orderId);
    if (r?.status === 'refunded') return r;
    await new Promise((res) => setTimeout(res, 20));
  }
  return (await refundsOf(orderId))[0];
}

// An order whose payment arrives after its hold expired AND the tickets were sold out: the money must go back.
async function lateSoldOutPayment() {
  const e = await event(2);
  const [ann, bob] = await users(2);
  const order = await pendingOrder(ann, e.id, 2);
  await pool.query("UPDATE orders SET expires_at = now() - interval '1 second' WHERE id = $1", [order.id]);
  await api('GET', `/api/orders/${order.id}`, { as: ann }); // expires; tickets back on sale…
  await pendingOrder(bob, e.id, 2); // …and Bob takes them
  return { e, ann, order };
}

test('paid after expiry and sold out → a refund is RECORDED with the payment, then REFUNDED, and the person is emailed', async () => {
  const { ann, order } = await lateSoldOutPayment();
  const result = await webhook(order, { paymentId: `pay_${RUN}_late` });
  assert.equal(result.outcome, 'refund_needed');

  const r = await waitForRefunded(order.id);
  assert.deepEqual([r.reason, r.amount_paise, r.payment_id, r.provider, r.status], ['sold_out_after_expiry', 99_800, `pay_${RUN}_late`, 'fake', 'refunded']);
  assert.match(r.provider_refund_id, /^rfnd_fake_/);

  const mail = mails.find((m) => m.to === ann.email && /Refund/.test(m.subject));
  assert.match(mail.subject, /₹998\.00/);
  assert.match(mail.text, /sold out/);

  const shown = (await api('GET', `/api/orders/${order.id}`, { as: ann })).body.order;
  assert.deepEqual([shown.status, shown.refund.status, shown.refund.amountPaise], ['failed', 'refunded', 99_800]);
});

test('the SAME payment reported again (another delivery) → still ONE refund, never two', async () => {
  const { order } = await lateSoldOutPayment();
  const paymentId = `pay_${RUN}_twice`;
  await webhook(order, { paymentId });
  await waitForRefunded(order.id);
  const again = await webhook(order, { paymentId }); // a different delivery id, same payment
  assert.equal(again.outcome, 'refund_needed');
  const all = await refundsOf(order.id);
  assert.equal(all.length, 1, 'UNIQUE (payment_id)');
});

test('a wrong amount → the order fails and what was PAID goes back', async () => {
  const e = await event();
  const [ann] = await users(1);
  const order = await pendingOrder(ann, e.id, 1);
  assert.equal((await webhook(order, { amountPaise: 100 })).outcome, 'failed');
  const r = await waitForRefunded(order.id);
  assert.deepEqual([r.reason, r.amount_paise], ['amount_mismatch', 100]);
});

test('admins see refunds and can retry a pending one; a done one → 409; normal users → 403', async () => {
  const { order } = await lateSoldOutPayment();
  await webhook(order);
  const r = await waitForRefunded(order.id);

  const list = (await api('GET', '/api/admin/refunds', { as: admin })).body.refunds;
  const mine = list.find((x) => x.id === Number(r.id));
  assert.deepEqual([mine.status, mine.reason, mine.amountPaise, mine.orderId], ['refunded', 'sold_out_after_expiry', 99_800, order.id]);
  assert.equal((await api('POST', `/api/admin/refunds/${r.id}/retry`, { as: admin })).body.error.code, 'ALREADY_REFUNDED');

  // A pending one (as if the provider had been down): Retry processes it.
  await pool.query("UPDATE refunds SET status = 'pending', provider_refund_id = NULL, refunded_at = NULL, error = 'timeout' WHERE id = $1", [r.id]);
  assert.equal((await api('POST', `/api/admin/refunds/${r.id}/retry`, { as: admin })).status, 202);
  assert.equal((await waitForRefunded(order.id)).status, 'refunded');

  const [ann] = await users(1);
  assert.equal((await api('GET', '/api/admin/refunds', { as: ann })).status, 403);
});
