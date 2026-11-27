// Paying for bus and train bookings (modules/booking-payments) with the fake provider: a booking with a
// fare is confirmed only by a signed payment webhook; every payment that buys nothing is refunded once;
// late payments; cancelling a paid booking refunds it. (Razorpay: razorpay.test.js.) Requires Docker.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createApp } from '../src/app.js';
import { env } from '../src/config/env.js';
import { pool } from '../src/config/db.js';
import { runMigrations } from '../src/db/migrate.js';
import { closeConnections } from '../src/config/connections.js';
import { signPayload, SIGNATURE_HEADER } from '../src/modules/payments/signature.js';
import { setMailTransport } from '../src/lib/mailer.js';
import { createSignedInUsers } from '../test-support/users.js';
import { holdWhileCreatingAdmins } from '../test-support/admin-lock.js';

const RUN = `test-bpay-${randomUUID().slice(0, 8)}`;
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
    // Refunds point at bookings without a foreign key: delete them first.
    await pool.query(
      `DELETE FROM refunds WHERE (booking_kind = 'bus' AND booking_id IN (SELECT b.id FROM bus_bookings b JOIN bus_trips t ON t.id = b.trip_id WHERE t.operator LIKE $1))
          OR (booking_kind = 'train' AND booking_id IN (SELECT b.id FROM train_bookings b JOIN train_trips t ON t.id = b.trip_id WHERE t.train_name LIKE $1))`,
      [`${RUN}%`],
    );
    await pool.query('DELETE FROM bus_trips WHERE operator LIKE $1', [`${RUN}%`]);
    await pool.query('DELETE FROM train_trips WHERE train_name LIKE $1', [`${RUN}%`]);
    await pool.query('DELETE FROM processed_webhooks WHERE webhook_id LIKE $1', [`${RUN}%`]);
    await pool.query("UPDATE users SET role = 'user' WHERE email LIKE $1", [`${RUN}%`]);
    await pool.query('DELETE FROM users WHERE email LIKE $1', [`${RUN}%`]);
  } finally {
    await releaseAdminsLock?.();
    server.close();
    await closeConnections();
  }
});

const users = (count) => createSignedInUsers(count, { prefix: `${RUN}-${++n}` });
async function api(method, path, { as, body, key } = {}) {
  const headers = {};
  if (as) headers.Cookie = as.cookie;
  if (body) headers['Content-Type'] = 'application/json';
  if (key) headers['Idempotency-Key'] = key;
  const res = await fetch(`${baseUrl}${path}`, { method, headers, body: body && JSON.stringify(body) });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}
const soon = (days = 3) => new Date(Date.now() + days * 86_400_000);

async function busTrip(farePaise = 50_000) {
  const departs = soon();
  const res = await api('POST', '/api/admin/bus/trips', {
    as: admin,
    body: { operator: `${RUN} Travels`, busNumber: 'KA01', from: `Pune ${++n}`, to: `Goa ${n}`, departsAt: departs.toISOString(), arrivesAt: new Date(departs.getTime() + 3_600_000).toISOString(), farePaise, rows: 2, seatColumns: 'AB' },
  });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  return res.body.trip;
}
async function trainTrip(farePaise = 80_000) {
  const departs = soon();
  const res = await api('POST', '/api/admin/train/trips', {
    as: admin,
    body: { trainNumber: '22101', trainName: `${RUN} Mail ${++n}`, from: `Delhi ${n}`, to: `Agra ${n}`, departsAt: departs.toISOString(), arrivesAt: new Date(departs.getTime() + 3_600_000).toISOString(), classes: [{ code: 'CC', farePaise, coaches: 1, berthsPerCoach: 4 }] },
  });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  return res.body.trip;
}
const people = (k) => Array.from({ length: k }, (_, i) => ({ name: `Rider ${i + 1}`, age: 30, gender: 'other' }));

// A bus booking with its passengers given, ready to pay.
async function readyBus(as, trip, seats = ['1A']) {
  const b = (await api('POST', `/api/bus/trips/${trip.id}/holds`, { as, body: { seats }, key: randomUUID() })).body.booking;
  await api('POST', `/api/bus/bookings/${b.id}/confirm`, { as, body: { passengers: seats.map((seat, i) => ({ seat, ...people(seats.length)[i] })) } });
  return b;
}
async function readyTrain(as, trip, travellers = 2) {
  const b = (await api('POST', `/api/train/trips/${trip.id}/holds`, { as, body: { classCode: 'CC', travellers }, key: randomUUID() })).body.booking;
  await api('POST', `/api/train/bookings/${b.id}/confirm`, { as, body: { passengers: people(travellers) } });
  return b;
}
// A signed delivery from the fake provider, sent directly (to control ids, amounts, timing).
function webhook(kind, bookingId, { amountPaise, paymentId = `pay_${RUN}_${randomUUID().slice(0, 8)}`, id = `${RUN}-evt-${randomUUID()}`, type = 'payment.succeeded', secret = env.payments.webhookSecret } = {}) {
  const body = JSON.stringify({ id, type, data: { orderId: bookingId, paymentId, amountPaise } });
  return fetch(`${baseUrl}/api/webhooks/booking-payments/${kind}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', [SIGNATURE_HEADER]: signPayload(body, secret) },
    body,
  }).then(async (r) => ({ status: r.status, body: await r.json() }));
}
const get = async (kind, as, id) => (await api('GET', `/api/${kind}/bookings/${id}`, { as })).body.booking;
const refundsOf = async (kind, id) => (await pool.query('SELECT * FROM refunds WHERE booking_kind = $1 AND booking_id = $2 ORDER BY id', [kind, id])).rows;
async function eventually(check) {
  for (let i = 0; i < 150; i++) {
    const v = await check();
    if (v) return v;
    await new Promise((r) => setTimeout(r, 20));
  }
  return check();
}

test('the fake provider end to end: pay → its signed webhook confirms → a receipt by email', async () => {
  const trip = await busTrip();
  const [ann] = await users(1);
  const b = await readyBus(ann, trip, ['1A', '1B']);
  assert.equal((await api('POST', `/api/bus/bookings/${b.id}/pay/fake`, { as: ann, body: { outcome: 'success' } })).status, 202);
  const paid = await eventually(async () => {
    const x = await get('bus', ann, b.id);
    return x.status === 'confirmed' && x;
  });
  assert.deepEqual([paid.payment.paid, paid.payment.provider, paid.amountPaise], [true, 'fake', 100_000]);
  const mail = await eventually(() => mails.find((m) => m.to === ann.email && /Bus booked/.test(m.subject)));
  assert.match(mail.text, /Seats: 1A, 1B/);
  assert.match(mail.text, /₹1,000\.00/);
});

test('paying needs the passengers first; not your booking → 404; a free trip confirms with no payment; a failed attempt keeps the hold', async () => {
  const trip = await busTrip();
  const [ann, bob] = await users(2);
  const b = (await api('POST', `/api/bus/trips/${trip.id}/holds`, { as: ann, body: { seats: ['2A'] }, key: randomUUID() })).body.booking;
  assert.equal((await api('POST', `/api/bus/bookings/${b.id}/pay/fake`, { as: ann, body: { outcome: 'success' } })).body.error.code, 'PASSENGERS_REQUIRED');
  await api('POST', `/api/bus/bookings/${b.id}/confirm`, { as: ann, body: { passengers: [{ seat: '2A', ...people(1)[0] }] } });
  assert.equal((await api('POST', `/api/bus/bookings/${b.id}/pay/fake`, { as: bob, body: { outcome: 'success' } })).body.error.code, 'BUS_BOOKING_NOT_FOUND');

  assert.equal((await webhook('bus', b.id, { type: 'payment.failed', amountPaise: 50_000 })).body.outcome, 'attempt_failed');
  assert.equal((await get('bus', ann, b.id)).status, 'held', 'a failed attempt changes nothing: pay again');
  assert.equal((await webhook('bus', b.id, { amountPaise: 50_000 })).body.outcome, 'paid');

  const free = await busTrip(0);
  const f = (await api('POST', `/api/bus/trips/${free.id}/holds`, { as: ann, body: { seats: ['1A'] }, key: randomUUID() })).body.booking;
  const confirmed = await api('POST', `/api/bus/bookings/${f.id}/confirm`, { as: ann, body: { passengers: [{ seat: '1A', ...people(1)[0] }] } });
  assert.deepEqual([confirmed.body.booking.status, confirmed.body.booking.payment], ['confirmed', null]);
  assert.equal((await api('POST', `/api/bus/bookings/${f.id}/pay/fake`, { as: ann, body: { outcome: 'success' } })).body.error.code, 'BOOKING_ALREADY_PAID');
});

test('the same delivery twice → "duplicate"; a SECOND payment for a paid booking → refunded; a wrong amount → refunded, still payable', async () => {
  const trip = await busTrip();
  const [ann] = await users(1);
  const b = await readyBus(ann, trip);
  const id = `${RUN}-evt-same`;
  assert.equal((await webhook('bus', b.id, { amountPaise: 50_000, id, paymentId: `pay_${RUN}_one` })).body.outcome, 'paid');
  assert.equal((await webhook('bus', b.id, { amountPaise: 50_000, id, paymentId: `pay_${RUN}_one` })).body.outcome, 'duplicate');
  assert.equal((await webhook('bus', b.id, { amountPaise: 50_000, paymentId: `pay_${RUN}_one` })).body.outcome, 'already_paid', 'same payment, another delivery id');
  assert.equal((await webhook('bus', b.id, { amountPaise: 50_000, paymentId: `pay_${RUN}_two` })).body.outcome, 'refund_needed');
  const [r] = await refundsOf('bus', b.id);
  assert.deepEqual([r.reason, r.payment_id, r.amount_paise], ['booking_not_payable', `pay_${RUN}_two`, 50_000]);

  const t2 = await busTrip();
  const c = await readyBus(ann, t2);
  assert.equal((await webhook('bus', c.id, { amountPaise: 100 })).body.outcome, 'amount_mismatch');
  assert.equal((await get('bus', ann, c.id)).status, 'held', 'still payable');
  assert.deepEqual((await refundsOf('bus', c.id)).map((x) => [x.reason, x.amount_paise]), [['amount_mismatch', 100]]);
});

test('LATE payment: the hold ran out but the seats are still free → confirmed; seats taken by someone else → expired and refunded', async () => {
  const trip = await busTrip();
  const [ann, bob] = await users(2);
  const b = await readyBus(ann, trip, ['2B']);
  await pool.query("UPDATE bus_bookings SET held_until = now() - interval '1 minute' WHERE id = $1", [b.id]);
  assert.equal((await webhook('bus', b.id, { amountPaise: 50_000 })).body.outcome, 'paid');
  assert.equal((await get('bus', ann, b.id)).status, 'confirmed');

  const c = await readyBus(ann, trip, ['1A']);
  await pool.query("UPDATE bus_bookings SET held_until = now() - interval '1 minute' WHERE id = $1", [c.id]);
  assert.equal((await api('POST', `/api/bus/trips/${trip.id}/holds`, { as: bob, body: { seats: ['1A'] }, key: randomUUID() })).status, 201, 'Bob takes the seat');
  assert.equal((await webhook('bus', c.id, { amountPaise: 50_000 })).body.outcome, 'refund_needed');
  assert.equal((await get('bus', ann, c.id)).status, 'expired');
  const r = await eventually(async () => (await refundsOf('bus', c.id)).find((x) => x.status === 'refunded'));
  assert.equal(r.reason, 'seats_unavailable');
  const seats = (await pool.query('SELECT count(*)::int AS n FROM bus_booking_seats WHERE trip_id = $1 AND seat_label = $2 AND active', [trip.id, '1A'])).rows[0].n;
  assert.equal(seats, 1, 'the seat is Bob\'s alone');
});

test('cancelling a PAID booking refunds it (bus and train), shown on the booking and emailed; a train gets its PNR when paid', async () => {
  const [ann] = await users(1);
  const bt = await busTrip();
  const b = await readyBus(ann, bt);
  await webhook('bus', b.id, { amountPaise: 50_000 });
  const cancelled = (await api('POST', `/api/bus/bookings/${b.id}/cancel`, { as: ann })).body.booking;
  assert.deepEqual([cancelled.status, cancelled.refund.reason], ['cancelled', 'booking_cancelled']);
  const r = await eventually(async () => (await refundsOf('bus', b.id)).find((x) => x.status === 'refunded'));
  assert.equal(r.amount_paise, 50_000);
  const mail = await eventually(() => mails.find((m) => m.to === ann.email && /^Refund: ₹500\.00 for Bus/.test(m.subject)));
  assert.match(mail.text, /you cancelled the booking/);

  const tt = await trainTrip();
  const t = await readyTrain(ann, tt, 2);
  assert.equal((await get('train', ann, t.id)).pnr, null);
  assert.equal((await webhook('train', t.id, { amountPaise: 160_000 })).body.outcome, 'paid');
  const paid = await get('train', ann, t.id);
  assert.match(paid.pnr, /^\d{10}$/);
  assert.ok(await eventually(() => mails.find((m) => m.to === ann.email && m.subject === `Train booked: PNR ${paid.pnr}`)));
  await api('POST', `/api/train/bookings/${t.id}/cancel`, { as: ann });
  assert.deepEqual((await refundsOf('train', t.id)).map((x) => [x.reason, x.amount_paise]), [['booking_cancelled', 160_000]]);

  const [notPaid] = (await pool.query("SELECT count(*)::int AS n FROM refunds WHERE booking_kind = 'bus' AND booking_id = $1 AND reason <> 'booking_cancelled'", [b.id])).rows;
  assert.equal(notPaid.n, 0);
});

test('webhooks: a wrong signature → 401; an unknown kind → 404; an unknown booking → unknown_booking', async () => {
  assert.equal((await webhook('bus', 1, { amountPaise: 1, secret: 'not-the-secret' })).status, 401);
  assert.equal((await webhook('boat', 1, { amountPaise: 1 })).status, 404);
  assert.equal((await webhook('bus', 999_999_999, { amountPaise: 1 })).body.outcome, 'unknown_booking');
});

test('RACE: 10 deliveries of one payment + a second payment, all at once → confirmed once, exactly one refund (the second payment)', async () => {
  const trip = await busTrip();
  const [ann] = await users(1);
  const b = await readyBus(ann, trip);
  const results = await Promise.all([
    ...Array.from({ length: 10 }, (_, i) => webhook('bus', b.id, { amountPaise: 50_000, paymentId: `pay_${RUN}_A`, id: `${RUN}-evt-A-${i}` })),
    webhook('bus', b.id, { amountPaise: 50_000, paymentId: `pay_${RUN}_B` }),
  ]);
  const outcomes = results.map((r) => r.body.outcome);
  assert.equal(outcomes.filter((o) => o === 'paid').length, 1, JSON.stringify(outcomes));
  const booking = (await pool.query('SELECT status, payment_id FROM bus_bookings WHERE id = $1', [b.id])).rows[0];
  assert.equal(booking.status, 'confirmed');
  const refunds = await refundsOf('bus', b.id);
  assert.equal(refunds.length, 1, 'exactly one payment refunded');
  assert.notEqual(refunds[0].payment_id, booking.payment_id, 'the one that did NOT confirm the booking');
});
