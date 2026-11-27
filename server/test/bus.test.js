// Bus booking (modules/bus): search, seat map, hold, confirm with passengers, cancel, history; and the
// guarantees: no seat in two active bookings (even when everyone clicks at once), no duplicate booking
// from a retried request. Requires Docker.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createApp } from '../src/app.js';
import { pool } from '../src/config/db.js';
import { runMigrations } from '../src/db/migrate.js';
import { closeConnections } from '../src/config/connections.js';
import { createSignedInUsers } from '../test-support/users.js';
import { holdWhileCreatingAdmins } from '../test-support/admin-lock.js';

const RUN = `test-bus-${randomUUID().slice(0, 8)}`;
let server, baseUrl, admin, releaseAdminsLock;
let n = 0;

before(async () => {
  await runMigrations({ log: () => {} });
  server = createApp().listen(0);
  baseUrl = `http://localhost:${server.address().port}`;
  releaseAdminsLock = await holdWhileCreatingAdmins();
  [admin] = await createSignedInUsers(1, { prefix: `${RUN}-admin`, role: 'admin' });
});

after(async () => {
  try {
    await pool.query('DELETE FROM bus_trips WHERE operator LIKE $1', [`${RUN}%`]); // bookings + seats cascade
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
  return { status: res.status, headers: res.headers, body: text ? JSON.parse(text) : null };
}
const istDate = (d) => new Date(d).toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' }); // YYYY-MM-DD

// A trip 3 days from now (a fresh pair of cities each time, so searches only see this test's trips).
async function trip({ rows = 3, seatColumns = 'ABCD', farePaise = 75_000, inDays = 3 } = {}) {
  const departs = new Date(Date.now() + inDays * 86_400_000);
  const from = `Pune ${RUN}-${++n}`;
  const to = `Goa ${RUN}-${n}`;
  const res = await api('POST', '/api/admin/bus/trips', {
    as: admin,
    body: {
      operator: `${RUN} Travels`,
      busNumber: 'MH12 AB 1234',
      from,
      to,
      departsAt: departs.toISOString(),
      arrivesAt: new Date(departs.getTime() + 8 * 3_600_000).toISOString(),
      farePaise,
      rows,
      seatColumns,
    },
  });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  return { ...res.body.trip, date: istDate(departs) };
}
const hold = (as, tripId, seats, key = randomUUID()) => api('POST', `/api/bus/trips/${tripId}/holds`, { as, body: { seats }, key });
const passengers = (seats) => seats.map((seat, i) => ({ seat, name: `Passenger ${i + 1}`, age: 30 + i, gender: 'female' }));
const activeSeats = async (tripId) =>
  (await pool.query('SELECT seat_label, count(*)::int AS n FROM bus_booking_seats WHERE trip_id = $1 AND active GROUP BY seat_label', [tripId])).rows;

test('admins create trips (seat map from rows × columns); bad input → 400; normal users → 403; audited', async () => {
  const t = await trip({ rows: 2, seatColumns: 'ABC' });
  assert.deepEqual(t.seatLabels, ['1A', '1B', '1C', '2A', '2B', '2C']);
  assert.equal(t.totalSeats, 6);

  const base = { operator: `${RUN} Travels`, busNumber: 'X1', from: 'Pune', to: 'Goa', farePaise: 100, rows: 1 };
  const soon = new Date(Date.now() + 86_400_000).toISOString();
  const later = new Date(Date.now() + 2 * 86_400_000).toISOString();
  const bad = [
    { ...base, departsAt: new Date(Date.now() - 60_000).toISOString(), arrivesAt: soon }, // in the past
    { ...base, to: 'pune', departsAt: soon, arrivesAt: later }, // same city
    { ...base, departsAt: later, arrivesAt: soon }, // arrives before it leaves
    { ...base, departsAt: soon, arrivesAt: later, seatColumns: 'AAB' }, // repeated column
  ];
  for (const body of bad) assert.equal((await api('POST', '/api/admin/bus/trips', { as: admin, body })).status, 400, JSON.stringify(body));

  const [ann] = await users(1);
  assert.equal((await api('POST', '/api/admin/bus/trips', { as: ann, body: base })).status, 403);

  const entry = (await pool.query("SELECT * FROM admin_audit_log WHERE action = 'bus.trip.create' AND target_id = $1", [String(t.id)])).rows[0];
  assert.ok(entry, 'recorded in the audit log, with the new trip as the target');
});

test('search: from/to in any letter case, by travel date (India), with seats left; the seat map never shows who', async () => {
  const t = await trip();
  const found = await api('GET', `/api/bus/trips?from=${encodeURIComponent(t.from.toUpperCase())}&to=${encodeURIComponent(t.to)}&date=${t.date}`);
  assert.deepEqual(found.body.trips.map((x) => [x.id, x.seatsLeft, x.farePaise]), [[t.id, 12, 75_000]]);

  const otherDay = istDate(Date.now() + 5 * 86_400_000);
  assert.deepEqual((await api('GET', `/api/bus/trips?from=${encodeURIComponent(t.from)}&to=${encodeURIComponent(t.to)}&date=${otherDay}`)).body.trips, []);
  assert.equal((await api('GET', `/api/bus/trips?from=Pune&to=Goa&date=27-11-2026`)).status, 400);
  assert.equal((await api('GET', `/api/bus/trips?from=Pune&to=pune&date=${t.date}`)).status, 400);

  const [ann] = await users(1);
  await hold(ann, t.id, ['1A', '1B']);
  const map = (await api('GET', `/api/bus/trips/${t.id}`)).body.trip;
  assert.equal(map.seatsLeft, 10);
  assert.deepEqual(map.seats.filter((s) => s.taken).map((s) => s.label), ['1A', '1B']);
  assert.ok(!JSON.stringify(map).includes(ann.email) && !('seatLabels' in map));
  assert.equal((await api('GET', '/api/bus/trips/999999999')).body.error.code, 'BUS_TRIP_NOT_FOUND');
});

// Pay with the fake provider and wait for its signed webhook to confirm the booking.
async function payAndWait(as, bookingId, outcome = 'success') {
  assert.equal((await api('POST', `/api/bus/bookings/${bookingId}/pay/fake`, { as, body: { outcome } })).status, 202);
  for (let i = 0; i < 100; i++) {
    const b = (await api('GET', `/api/bus/bookings/${bookingId}`, { as })).body.booking;
    if (b.status !== 'held') return b;
    await new Promise((r) => setTimeout(r, 20));
  }
  return (await api('GET', `/api/bus/bookings/${bookingId}`, { as })).body.booking;
}

test('hold → passengers → PAY → confirmed → in my history; the price comes from the trip, not the request', async () => {
  const t = await trip({ farePaise: 60_000 });
  const [ann] = await users(1);
  const held = await hold(ann, t.id, ['2C', '2d']);
  assert.equal(held.status, 201, JSON.stringify(held.body));
  const b = held.body.booking;
  assert.deepEqual([b.status, b.amountPaise, b.seats.map((s) => s.label)], ['held', 120_000, ['2C', '2D']]);
  const minutesLeft = (new Date(b.heldUntil) - Date.now()) / 60_000;
  assert.ok(minutesLeft > 9 && minutesLeft <= 10, `held for 10 minutes (${minutesLeft})`);

  const wrong = await api('POST', `/api/bus/bookings/${b.id}/confirm`, { as: ann, body: { passengers: passengers(['2C']) } });
  assert.equal(wrong.body.error.code, 'PASSENGERS_MISMATCH');

  const ok = await api('POST', `/api/bus/bookings/${b.id}/confirm`, { as: ann, body: { passengers: passengers(['2D', '2C']), contactPhone: '+91 98765 43210' } });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  // A trip with a fare: the details are saved, and the booking waits for payment.
  assert.deepEqual([ok.body.booking.status, ok.body.booking.passengersGiven, ok.body.booking.payment.paid], ['held', true, false]);
  const paid = await payAndWait(ann, b.id);
  assert.deepEqual([paid.status, paid.payment.paid, paid.payment.provider, paid.heldUntil], ['confirmed', true, 'fake', null]);
  assert.deepEqual(paid.seats.find((s) => s.label === '2D').passenger, { name: 'Passenger 1', age: 30, gender: 'female' });
  const again = await api('POST', `/api/bus/bookings/${b.id}/confirm`, { as: ann, body: { passengers: passengers(['2C', '2D']) } });
  assert.deepEqual([again.status, again.body.booking.status], [200, 'confirmed'], 'confirming twice is harmless');

  const history = (await api('GET', '/api/bus/bookings', { as: ann })).body.bookings;
  assert.deepEqual(history.map((x) => [x.id, x.status, x.trip.from]), [[b.id, 'confirmed', t.from]]);

  const [bob] = await users(1);
  assert.equal((await api('GET', `/api/bus/bookings/${b.id}`, { as: bob })).body.error.code, 'BUS_BOOKING_NOT_FOUND', "someone else's booking: 404");
  assert.equal((await api('POST', `/api/bus/bookings/${b.id}/cancel`, { as: bob })).status, 404);
});

test('holding: taken seats → 409 with which; unknown seat → 400; one hold per person per trip; key required; admins and guests refused', async () => {
  const t = await trip();
  const [ann, bob] = await users(2);
  await hold(ann, t.id, ['1A', '1B']);
  const clash = await hold(bob, t.id, ['1B', '1C']);
  assert.deepEqual([clash.status, clash.body.error.code, clash.body.error.details.seats], [409, 'SEATS_TAKEN', ['1B']]);
  assert.equal((await hold(bob, t.id, ['9A'])).body.error.code, 'UNKNOWN_SEATS', 'this bus has 3 rows');
  assert.equal((await hold(bob, t.id, ['1A', '1A'])).status, 400, 'a seat listed twice');
  assert.equal((await hold(bob, t.id, ['1A', '1B', '1C', '1D', '2A', '2B', '2C'])).status, 400, 'more than 6 seats');
  assert.equal((await hold(ann, t.id, ['3A'])).body.error.code, 'BUS_HOLD_EXISTS');
  assert.equal((await api('POST', `/api/bus/trips/${t.id}/holds`, { as: bob, body: { seats: ['3A'] } })).body.error.code, 'IDEMPOTENCY_KEY_REQUIRED');
  assert.equal((await hold(admin, t.id, ['3A'])).body.error.code, 'ADMINS_CANNOT_BUY');
  assert.equal((await hold(null, t.id, ['3A'])).status, 401);
});

test('the SAME request retried (same Idempotency-Key) → the same booking, even 10 at once; a different request with it → 422', async () => {
  const t = await trip();
  const [ann] = await users(1);
  const key = randomUUID();
  const results = await Promise.all(Array.from({ length: 10 }, () => hold(ann, t.id, ['2A', '2B'], key)));
  const ids = new Set(results.map((r) => r.body.booking?.id));
  assert.equal(ids.size, 1, JSON.stringify(results.map((r) => r.body)));
  assert.deepEqual(results.map((r) => r.status).sort(), [200, 200, 200, 200, 200, 200, 200, 200, 200, 201]);
  assert.equal(results.find((r) => r.status === 200).headers.get('idempotent-replayed'), 'true');
  assert.equal((await hold(ann, t.id, ['3A'], key)).body.error.code, 'IDEMPOTENCY_KEY_REUSED');
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM bus_bookings WHERE trip_id = $1', [t.id])).rows[0].n, 1);
});

test('RACE: 25 people grab the SAME seat at once → exactly one gets it', async () => {
  const t = await trip();
  const people = await users(25);
  const results = await Promise.all(people.map((p) => hold(p, t.id, ['1A'])));
  const codes = results.map((r) => r.status);
  assert.equal(codes.filter((c) => c === 201).length, 1, JSON.stringify(codes));
  assert.ok(results.filter((r) => r.status !== 201).every((r) => r.body.error.code === 'SEATS_TAKEN'));
  assert.deepEqual(await activeSeats(t.id), [{ seat_label: '1A', n: 1 }]);
});

test('RACE: 30 people grab overlapping pairs of 12 seats → no seat in two bookings, and every winner got exactly their seats', async () => {
  const t = await trip();
  const people = await users(30);
  const labels = t.seatLabels; // 12 seats
  const wants = people.map((_, i) => [labels[i % 12], labels[(i * 5 + 1) % 12]].filter((s, j, a) => a.indexOf(s) === j));
  const results = await Promise.all(people.map((p, i) => hold(p, t.id, wants[i])));
  const winners = results.map((r, i) => (r.status === 201 ? i : -1)).filter((i) => i >= 0);
  assert.ok(winners.length >= 1 && results.every((r) => r.status === 201 || r.body.error.code === 'SEATS_TAKEN'));
  const seats = await activeSeats(t.id);
  assert.ok(seats.every((s) => s.n === 1), 'never two active bookings on one seat');
  const won = winners.flatMap((i) => wants[i]).sort();
  assert.deepEqual(seats.map((s) => s.seat_label).sort(), won, 'the seats taken are exactly the winners\' seats');
});

test('a hold that runs out gives its seats back, and can no longer be confirmed', async () => {
  const t = await trip();
  const [ann, bob] = await users(2);
  const b = (await hold(ann, t.id, ['3C'])).body.booking;
  await pool.query("UPDATE bus_bookings SET held_until = now() - interval '1 second' WHERE id = $1", [b.id]);
  assert.equal((await api('GET', `/api/bus/trips/${t.id}`)).body.trip.seatsLeft, 12, 'free again at once');
  const late = await api('POST', `/api/bus/bookings/${b.id}/confirm`, { as: ann, body: { passengers: passengers(['3C']) } });
  assert.equal(late.body.error.code, 'BUS_HOLD_EXPIRED');
  assert.equal((await hold(bob, t.id, ['3C'])).status, 201, 'someone else can take the seat');
  assert.equal((await api('GET', `/api/bus/bookings/${b.id}`, { as: ann })).body.booking.status, 'expired');
});

test('cancel: the seats go back; twice → 409; after departure → 409', async () => {
  const t = await trip();
  const [ann, bob] = await users(2);
  const b = (await hold(ann, t.id, ['1D'])).body.booking;
  await api('POST', `/api/bus/bookings/${b.id}/confirm`, { as: ann, body: { passengers: passengers(['1D']) } });
  const cancelled = await api('POST', `/api/bus/bookings/${b.id}/cancel`, { as: ann });
  assert.deepEqual([cancelled.status, cancelled.body.booking.status], [200, 'cancelled']);
  assert.equal((await api('POST', `/api/bus/bookings/${b.id}/cancel`, { as: ann })).body.error.code, 'BUS_BOOKING_NOT_ACTIVE');
  assert.equal((await hold(bob, t.id, ['1D'])).status, 201, 'the seat is free again');

  const gone = await trip();
  const c = (await hold(ann, gone.id, ['1A'])).body.booking;
  await pool.query("UPDATE bus_trips SET departs_at = now() - interval '1 hour', arrives_at = now() + interval '1 hour' WHERE id = $1", [gone.id]);
  assert.equal((await api('POST', `/api/bus/bookings/${c.id}/cancel`, { as: ann })).body.error.code, 'BUS_TRIP_DEPARTED');
  assert.equal((await hold(bob, gone.id, ['2A'])).body.error.code, 'BUS_TRIP_DEPARTED');
});
