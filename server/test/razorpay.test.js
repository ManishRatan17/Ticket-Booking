// Phase 7: real payments with Razorpay (test mode), against a FAKE Razorpay. Requires Docker.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { startFakeRazorpay } from '../test-support/fake-razorpay.js';

const KEYS = { keyId: 'rzp_test_abc123', keySecret: 'test-key-secret', webhookSecret: 'test-webhook-secret' };
const razorpay = await startFakeRazorpay(KEYS);
// Before the app is imported (env.js reads these once): Razorpay ON, pointed at the fake.
Object.assign(process.env, {
  RAZORPAY_KEY_ID: KEYS.keyId,
  RAZORPAY_KEY_SECRET: KEYS.keySecret,
  RAZORPAY_WEBHOOK_SECRET: KEYS.webhookSecret,
  RAZORPAY_API_URL: razorpay.apiUrl,
});

const { createApp } = await import('../src/app.js');
const { pool } = await import('../src/config/db.js');
const { redis } = await import('../src/config/redis.js');
const { runMigrations } = await import('../src/db/migrate.js');
const { closeConnections } = await import('../src/config/connections.js');
const { createEvent } = await import('../src/modules/events/events.service.js');
const { stockKey } = await import('../src/modules/reservation/stock.js');
const { createSignedInUsers } = await import('../test-support/users.js');
const { deleteEventKeys } = await import('../test-support/redis-cleanup.js');

await runMigrations({ log: () => {} });
const server = createApp().listen(0);
const baseUrl = `http://localhost:${server.address().port}`;
const RUN = `test-rzp-${randomUUID().slice(0, 8)}`;
let n = 0;
const createdEventIds = [];

after(async () => {
  try {
    await deleteEventKeys(createdEventIds);
    if (createdEventIds.length) {
      await pool.query('DELETE FROM sold_tickets WHERE event_id = ANY($1)', [createdEventIds]);
      await pool.query('DELETE FROM orders WHERE event_id = ANY($1)', [createdEventIds]);
      await pool.query('DELETE FROM events WHERE id = ANY($1)', [createdEventIds]);
    }
    // Only this file's deliveries: Razorpay ones, and the fake Razorpay's ids (rzp_pay_…, evt_…).
    await pool.query("DELETE FROM processed_webhooks WHERE provider = 'razorpay' AND (webhook_id LIKE 'rzp_%' OR webhook_id LIKE 'evt_%')");
    await pool.query('DELETE FROM users WHERE email LIKE $1', [`${RUN}%`]);
  } finally {
    server.close();
    await razorpay.close();
    await closeConnections();
  }
});

async function event(tickets = 10) {
  const e = await createEvent({ name: `${RUN} event ${++n}`, totalTickets: tickets, pricePaise: 49_900, saleStartsAt: new Date(Date.now() - 60_000) });
  createdEventIds.push(e.id);
  return e;
}
const users = (count) => createSignedInUsers(count, { prefix: `${RUN}-${++n}` });

async function api(method, path, { as, body, headers = {} } = {}) {
  const h = { ...headers };
  if (as) h.Cookie = as.cookie;
  if (body) h['Content-Type'] = 'application/json';
  const res = await fetch(`${baseUrl}${path}`, { method, headers: h, body: body && JSON.stringify(body) });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}
async function pendingOrder(as, e, quantity = 2) {
  const hold = (await api('POST', `/api/events/${e.id}/holds`, { as, body: { quantity } })).body.hold;
  return (await api('POST', '/api/orders', { as, body: { holdId: hold.id }, headers: { 'Idempotency-Key': randomUUID() } })).body.order;
}
const start = (as, order) => api('POST', `/api/payments/razorpay/${order.id}`, { as });
const verify = (as, order, answer) => api('POST', `/api/payments/razorpay/${order.id}/verify`, { as, body: answer });
const getOrder = async (as, order) => (await api('GET', `/api/orders/${order.id}`, { as })).body.order;
const sendWebhook = ({ body, headers }) =>
  fetch(`${baseUrl}/api/webhooks/razorpay`, { method: 'POST', headers, body }).then(async (r) => ({ status: r.status, body: await r.json() }));

// ---------- setup ----------

test('the page learns it should open Razorpay, with the PUBLIC key id (never the secret)', async () => {
  const config = (await api('GET', '/api/config')).body;
  assert.deepEqual(config.payments, { provider: 'razorpay', keyId: KEYS.keyId });
  assert.ok(!JSON.stringify(config).includes(KEYS.keySecret));
});

test('with Razorpay configured, the fake provider is OFF (nobody gets tickets by pressing a fake "Pay")', async () => {
  const e = await event();
  const [ann] = await users(1);
  const order = await pendingOrder(ann, e);
  const res = await api('POST', `/api/payments/fake/${order.id}`, { as: ann, body: { outcome: 'success' } });
  assert.equal(res.status, 404);
  assert.equal(res.body.error.code, 'FAKE_PAYMENTS_OFF');
});

// ---------- step 1: starting a payment ----------

test('start → a Razorpay order for EXACTLY the order\'s amount (₹998.00 = 99,800 paise), INR; asking again reuses it', async () => {
  const e = await event();
  const [ann] = await users(1);
  const order = await pendingOrder(ann, e, 2);
  const before = razorpay.calls.length;

  const first = await start(ann, order);
  assert.equal(first.status, 200);
  assert.deepEqual([first.body.keyId, first.body.amountPaise, first.body.currency], [KEYS.keyId, 99_800, 'INR']);
  assert.match(first.body.razorpayOrderId, /^order_/);
  const call = razorpay.calls.at(-1);
  assert.equal(call.auth, true, 'authenticated with key id + secret');
  assert.deepEqual([call.body.amount, call.body.currency, call.body.receipt], [99_800, 'INR', `order_${order.id}`]);

  const again = await start(ann, order);
  assert.equal(again.body.razorpayOrderId, first.body.razorpayOrderId);
  assert.equal(razorpay.calls.length, before + 1, 'Razorpay was asked once');
});

test('someone else\'s order → 404; an order that isn\'t pending → 409', async () => {
  const e = await event();
  const [ann, bob] = await users(2);
  const order = await pendingOrder(ann, e);
  assert.equal((await start(bob, order)).status, 404);
  const rzp = (await start(ann, order)).body;
  await verify(ann, order, razorpay.pay(rzp.razorpayOrderId));
  assert.equal((await start(ann, order)).body.error.code, 'ORDER_NOT_PENDING');
});

// ---------- step 3: the checkout window's answer ----------

test('a VALID signature → paid, with ticket numbers; the tickets are taken once even if confirmed twice', async () => {
  const e = await event();
  const [ann] = await users(1);
  const order = await pendingOrder(ann, e, 2);
  const rzp = (await start(ann, order)).body;
  const answer = razorpay.pay(rzp.razorpayOrderId);

  assert.deepEqual((await verify(ann, order, answer)).body, { outcome: 'paid' });
  const paid = await getOrder(ann, order);
  assert.deepEqual([paid.status, paid.ticketNumbers], ['paid', [1, 2]]);

  assert.equal((await verify(ann, order, answer)).body.outcome, 'duplicate', 'the same confirmation again changes nothing');
  assert.equal(Number(await redis.get(stockKey(e.id))), 8);
});

test('a FORGED signature (or another order\'s payment) → 400, the order stays pending', async () => {
  const e = await event();
  const [ann] = await users(1);
  const order = await pendingOrder(ann, e);
  const rzp = (await start(ann, order)).body;

  const forged = razorpay.pay(rzp.razorpayOrderId, { secret: 'not-the-secret' });
  const res = await verify(ann, order, forged);
  assert.equal(res.status, 400);
  assert.equal(res.body.error.code, 'PAYMENT_SIGNATURE_INVALID');

  // Bob really pays HIS order; Ann sends Bob's (genuinely signed) payment as if it were for hers.
  const [bob] = await users(1);
  const bobsOrder = await pendingOrder(bob, e);
  const bobsRzp = (await start(bob, bobsOrder)).body;
  const bobsPayment = razorpay.pay(bobsRzp.razorpayOrderId);
  assert.equal((await verify(ann, order, bobsPayment)).status, 400, 'a valid payment for ANOTHER order is refused');
  assert.equal((await getOrder(ann, order)).status, 'pending');
});

// ---------- step 4: Razorpay's webhook ----------

test('webhook payment.captured (the tab was closed before confirming) → paid', async () => {
  const e = await event();
  const [ann] = await users(1);
  const order = await pendingOrder(ann, e, 1);
  const rzp = (await start(ann, order)).body;

  const res = await sendWebhook(razorpay.webhook('payment.captured', rzp.razorpayOrderId));
  assert.equal(res.status, 200);
  assert.equal(res.body.outcome, 'paid');
  assert.equal((await getOrder(ann, order)).status, 'paid');
});

test('BOTH the page and the webhook report the same payment → one paid order, tickets taken once', async () => {
  const e = await event();
  const [ann] = await users(1);
  const order = await pendingOrder(ann, e, 2);
  const rzp = (await start(ann, order)).body;
  const answer = razorpay.pay(rzp.razorpayOrderId);
  const hook = razorpay.webhook('payment.captured', rzp.razorpayOrderId, { paymentId: answer.razorpay_payment_id });

  const [a, b] = await Promise.all([verify(ann, order, answer), sendWebhook(hook)]);
  assert.deepEqual([a.body.outcome, b.body.outcome].sort(), ['already_paid', 'paid']);
  const { rows } = await pool.query('SELECT count(*)::int AS n FROM sold_tickets WHERE order_id = $1', [order.id]);
  assert.equal(rows[0].n, 2);
});

test('webhook payment.failed = ONE failed attempt: the order stays pending, so a retry with another card still works', async () => {
  const e = await event();
  const [ann] = await users(1);
  const order = await pendingOrder(ann, e, 3);
  const rzp = (await start(ann, order)).body;

  assert.equal((await sendWebhook(razorpay.webhook('payment.failed', rzp.razorpayOrderId))).body.outcome, 'attempt_failed');
  assert.equal((await getOrder(ann, order)).status, 'pending');
  assert.equal(Number(await redis.get(stockKey(e.id))), 7, 'still held for her (released at expiry if she gives up)');

  // She tries another card in the same window: paid, no refund needed.
  assert.equal((await verify(ann, order, razorpay.pay(rzp.razorpayOrderId))).body.outcome, 'paid');
});

test('webhooks: wrong signature → 401; the same delivery twice → "duplicate"; unknown order / other events → ignored', async () => {
  const e = await event();
  const [ann] = await users(1);
  const order = await pendingOrder(ann, e, 1);
  const rzp = (await start(ann, order)).body;

  assert.equal((await sendWebhook(razorpay.webhook('payment.captured', rzp.razorpayOrderId, { secret: 'wrong' }))).status, 401);
  const hook = razorpay.webhook('payment.captured', rzp.razorpayOrderId);
  assert.equal((await sendWebhook(hook)).body.outcome, 'paid');
  assert.equal((await sendWebhook(hook)).body.outcome, 'duplicate');
  assert.equal((await sendWebhook(razorpay.webhook('payment.captured', 'order_nobody'))).body.outcome, 'unknown_order');
  assert.equal((await sendWebhook(razorpay.webhook('order.paid', rzp.razorpayOrderId))).body.outcome, 'ignored');
});

test('webhook with a different AMOUNT than the order → failed (never sell for the wrong price)', async () => {
  const e = await event();
  const [ann] = await users(1);
  const order = await pendingOrder(ann, e, 1);
  const rzp = (await start(ann, order)).body;
  assert.equal((await sendWebhook(razorpay.webhook('payment.captured', rzp.razorpayOrderId, { amount: 100 }))).body.outcome, 'failed');
  assert.equal((await getOrder(ann, order)).failureReason, 'amount_mismatch');
});

// ---------- refunds through Razorpay ----------

const { processRefund } = await import('../src/modules/payments/refunds.js');
const refundOf = async (order) => (await pool.query('SELECT * FROM refunds WHERE order_id = $1', [order.id])).rows[0];
async function settled(order) {
  for (let i = 0; i < 100; i++) {
    const r = await refundOf(order);
    if (r && (r.status === 'refunded' || r.error)) return r;
    await new Promise((res) => setTimeout(res, 20));
  }
  return refundOf(order);
}

test('refund via Razorpay: POST /payments/:id/refund for the amount, tagged with our refund id', async () => {
  const e = await event();
  const [ann] = await users(1);
  const order = await pendingOrder(ann, e, 1);
  const rzp = (await start(ann, order)).body;
  const hook = razorpay.webhook('payment.captured', rzp.razorpayOrderId, { amount: 100 }); // wrong amount → refund
  assert.equal((await sendWebhook(hook)).body.outcome, 'failed');

  const r = await settled(order);
  assert.equal(r.status, 'refunded');
  const atRazorpay = razorpay.refunds.filter((x) => x.payment_id === hook.paymentId);
  assert.equal(atRazorpay.length, 1);
  assert.deepEqual([atRazorpay[0].amount, atRazorpay[0].notes.refundId], [100, String(r.id)]);
  assert.equal(r.provider_refund_id, atRazorpay[0].id);
});

test('Razorpay down → the refund stays pending WITH the error; a retry later refunds it', async (t) => {
  t.after(() => razorpay.setRefundMode('ok'));
  const e = await event();
  const [ann] = await users(1);
  const order = await pendingOrder(ann, e, 1);
  const rzp = (await start(ann, order)).body;
  razorpay.setRefundMode('fail');
  await sendWebhook(razorpay.webhook('payment.captured', rzp.razorpayOrderId, { amount: 100 }));

  const pending = await settled(order);
  assert.equal(pending.status, 'pending');
  assert.match(pending.error, /Razorpay refused the refund: 500/);

  razorpay.setRefundMode('ok');
  assert.deepEqual(await processRefund({ refundId: Number(pending.id) }), { status: 'refunded' });
  assert.equal((await refundOf(order)).error, null);
});

test('the answer got LOST after Razorpay refunded (timeout) → the retry finds that refund: refunded ONCE', async (t) => {
  t.after(() => razorpay.setRefundMode('ok'));
  const e = await event();
  const [ann] = await users(1);
  const order = await pendingOrder(ann, e, 1);
  const rzp = (await start(ann, order)).body;
  razorpay.setRefundMode('timeout_after_refund');
  const hook = razorpay.webhook('payment.captured', rzp.razorpayOrderId, { amount: 100 });
  await sendWebhook(hook);
  const first = await settled(order);
  assert.equal(first.status, 'pending', 'we got no answer, so we don\'t know yet');

  razorpay.setRefundMode('ok');
  await processRefund({ refundId: Number(first.id) });
  assert.equal((await refundOf(order)).status, 'refunded');
  assert.equal(razorpay.refunds.filter((x) => x.payment_id === hook.paymentId).length, 1, 'money sent back once');
});

// ---------- bus and train BOOKINGS through Razorpay (modules/booking-payments) ----------
const busService = await import('../src/modules/bus/bus.service.js');
const trainService = await import('../src/modules/train/train.service.js');
const later = (days) => new Date(Date.now() + days * 86_400_000);

test('a BUS booking paid through Razorpay: one Razorpay order for the exact fare; the page\'s signed answer confirms it; a forged one → 400', async () => {
  const trip = await busService.createTrip(
    { operator: `${RUN} Bus`, busNumber: 'MH01', from: `Pune ${RUN}`, to: `Goa ${RUN}`, departsAt: later(3).toISOString(), arrivesAt: later(3.1).toISOString(), farePaise: 45_000, rows: 1, seatColumns: 'AB' },
    null,
  );
  try {
    const [ann] = await users(1);
    const b = (await api('POST', `/api/bus/trips/${trip.id}/holds`, { as: ann, body: { seats: ['1A', '1B'] }, headers: { 'Idempotency-Key': randomUUID() } })).body.booking;
    await api('POST', `/api/bus/bookings/${b.id}/confirm`, {
      as: ann,
      body: { passengers: [{ seat: '1A', name: 'Ann One', age: 30, gender: 'female' }, { seat: '1B', name: 'Ann Two', age: 31, gender: 'female' }] },
    });
    const rzp = (await api('POST', `/api/bus/bookings/${b.id}/pay/razorpay`, { as: ann })).body;
    assert.equal(rzp.amountPaise, 90_000);
    assert.equal((await api('POST', `/api/bus/bookings/${b.id}/pay/razorpay`, { as: ann })).body.razorpayOrderId, rzp.razorpayOrderId, 'created once');
    assert.equal((await api('POST', `/api/bus/bookings/${b.id}/pay/fake`, { as: ann, body: { outcome: 'success' } })).body.error.code, 'FAKE_PAYMENTS_OFF');
    const forged = await api('POST', `/api/bus/bookings/${b.id}/pay/razorpay/verify`, { as: ann, body: razorpay.pay(rzp.razorpayOrderId, { secret: 'not-the-secret' }) });
    assert.equal(forged.body.error.code, 'PAYMENT_SIGNATURE_INVALID');
    assert.equal((await api('POST', `/api/bus/bookings/${b.id}/pay/razorpay/verify`, { as: ann, body: razorpay.pay(rzp.razorpayOrderId) })).body.outcome, 'paid');
    const shown = (await api('GET', `/api/bus/bookings/${b.id}`, { as: ann })).body.booking;
    assert.deepEqual([shown.status, shown.payment.provider], ['confirmed', 'razorpay']);
  } finally {
    await pool.query('DELETE FROM bus_trips WHERE id = $1', [trip.id]);
  }
});

test("a TRAIN booking confirmed by Razorpay's webhook alone (the tab was closed): it gets its PNR; the same delivery again → duplicate", async () => {
  const trip = await trainService.createTrip(
    { trainNumber: '12951', trainName: `${RUN} Rajdhani`, from: `Mumbai ${RUN}`, to: `Delhi ${RUN}`, departsAt: later(3).toISOString(), arrivesAt: later(3.5).toISOString(), classes: [{ code: '3A', farePaise: 150_000, coaches: 1, berthsPerCoach: 2 }] },
    null,
  );
  try {
    const [ann] = await users(1);
    const b = (await api('POST', `/api/train/trips/${trip.id}/holds`, { as: ann, body: { classCode: '3A', travellers: 1 }, headers: { 'Idempotency-Key': randomUUID() } })).body.booking;
    await api('POST', `/api/train/bookings/${b.id}/confirm`, { as: ann, body: { passengers: [{ name: 'Ann Rider', age: 30, gender: 'female' }] } });
    const rzp = (await api('POST', `/api/train/bookings/${b.id}/pay/razorpay`, { as: ann })).body;
    const delivery = razorpay.webhook('payment.captured', rzp.razorpayOrderId);
    assert.equal((await sendWebhook(delivery)).body.outcome, 'paid');
    assert.equal((await sendWebhook(delivery)).body.outcome, 'duplicate');
    const shown = (await api('GET', `/api/train/bookings/${b.id}`, { as: ann })).body.booking;
    assert.equal(shown.status, 'confirmed');
    assert.match(shown.pnr, /^\d{10}$/);
  } finally {
    await pool.query('DELETE FROM train_trips WHERE id = $1', [trip.id]);
  }
});
