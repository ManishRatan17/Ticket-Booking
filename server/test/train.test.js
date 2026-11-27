// Train booking (modules/train): search with classes, server-allocated berths, PNR, cancel, history;
// no berth in two active bookings even under a rush; no duplicate booking from a retry; and the
// external provider answers honestly (503/501), never with invented data. Requires Docker.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createApp } from '../src/app.js';
import { env } from '../src/config/env.js';
import { pool } from '../src/config/db.js';
import { runMigrations } from '../src/db/migrate.js';
import { closeConnections } from '../src/config/connections.js';
import { createSignedInUsers } from '../test-support/users.js';
import { holdWhileCreatingAdmins } from '../test-support/admin-lock.js';

const RUN = `test-train-${randomUUID().slice(0, 8)}`;
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
    await pool.query('DELETE FROM train_trips WHERE train_name LIKE $1', [`${RUN}%`]); // classes, bookings, berths cascade
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
const istDate = (d) => new Date(d).toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });

// A trip 3 days from now; by default 3A (1 coach × 4 berths, ₹1,250) and SL (2 × 3, ₹450).
async function trip(classes = [{ code: '3A', farePaise: 125_000, coaches: 1, berthsPerCoach: 4 }, { code: 'SL', farePaise: 45_000, coaches: 2, berthsPerCoach: 3 }]) {
  const departs = new Date(Date.now() + 3 * 86_400_000);
  const res = await api('POST', '/api/admin/train/trips', {
    as: admin,
    body: {
      trainNumber: '12123',
      trainName: `${RUN} Express ${++n}`,
      from: `Mumbai ${RUN}-${n}`,
      to: `Pune ${RUN}-${n}`,
      departsAt: departs.toISOString(),
      arrivesAt: new Date(departs.getTime() + 3 * 3_600_000).toISOString(),
      classes,
    },
  });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  return { ...res.body.trip, date: istDate(departs) };
}
const hold = (as, tripId, classCode, travellers, key = randomUUID()) =>
  api('POST', `/api/train/trips/${tripId}/holds`, { as, body: { classCode, travellers }, key });
const people = (count) => Array.from({ length: count }, (_, i) => ({ name: `Traveller ${i + 1}`, age: 25 + i, gender: i % 2 ? 'male' : 'female' }));
const activeBerths = async (tripId) =>
  (await pool.query('SELECT berth_label, count(*)::int AS n FROM train_booking_berths WHERE trip_id = $1 AND active GROUP BY berth_label', [tripId])).rows;

test('admins create trips (classes with coaches × berths); bad input → 400; normal users → 403; audited', async () => {
  const t = await trip();
  assert.deepEqual(
    t.classes.map((c) => [c.code, c.total, c.available, c.farePaise]),
    [
      ['3A', 4, 4, 125_000],
      ['SL', 6, 6, 45_000],
    ],
  );
  const base = { trainNumber: '12123', trainName: 'X', from: 'Mumbai', to: 'Pune', classes: [{ code: 'SL', farePaise: 1, coaches: 1, berthsPerCoach: 1 }] };
  const soon = new Date(Date.now() + 86_400_000).toISOString();
  const later = new Date(Date.now() + 2 * 86_400_000).toISOString();
  for (const body of [
    { ...base, departsAt: new Date(Date.now() - 60_000).toISOString(), arrivesAt: soon }, // in the past
    { ...base, to: 'mumbai', departsAt: soon, arrivesAt: later }, // same city
    { ...base, trainNumber: 'ABC', departsAt: soon, arrivesAt: later }, // not a train number
    { ...base, departsAt: soon, arrivesAt: later, classes: [base.classes[0], base.classes[0]] }, // class twice
    { ...base, departsAt: soon, arrivesAt: later, classes: [{ ...base.classes[0], code: 'XX' }] }, // unknown class
  ]) {
    assert.equal((await api('POST', '/api/admin/train/trips', { as: admin, body })).status, 400, JSON.stringify(body));
  }
  const [ann] = await users(1);
  assert.equal((await api('POST', '/api/admin/train/trips', { as: ann, body: base })).status, 403);
  const entry = (await pool.query("SELECT 1 FROM admin_audit_log WHERE action = 'train.trip.create' AND target_id = $1", [String(t.id)])).rows[0];
  assert.ok(entry, 'recorded in the audit log');
});

test('search: cities in any case, Indian travel date, optional class filter, availability per class', async () => {
  const t = await trip();
  const q = (extra = '') => api('GET', `/api/train/trips?from=${encodeURIComponent(t.from.toUpperCase())}&to=${encodeURIComponent(t.to)}&date=${t.date}${extra}`);
  assert.deepEqual((await q()).body.trips.map((x) => x.id), [t.id]);
  assert.deepEqual((await q('&classCode=SL')).body.trips.map((x) => x.id), [t.id]);
  assert.deepEqual((await q('&classCode=1A')).body.trips, [], 'this train has no 1A');
  assert.equal((await q('&classCode=ZZ')).status, 400);
  assert.equal((await api('GET', `/api/train/trips?from=A1&to=B2&date=01-12-2026`)).status, 400);
  assert.equal((await api('GET', '/api/train/trips/999999999')).body.error.code, 'TRAIN_TRIP_NOT_FOUND');
});

test('hold: the server allocates berths in order → confirm with travellers → a PNR → in my history', async () => {
  const t = await trip();
  const [ann] = await users(1);
  const held = await hold(ann, t.id, '3A', 2);
  assert.equal(held.status, 201, JSON.stringify(held.body));
  const b = held.body.booking;
  assert.deepEqual([b.status, b.classCode, b.amountPaise, b.travellers.map((x) => x.berth), b.pnr], ['held', '3A', 250_000, ['B1-1', 'B1-2'], null]);

  const wrong = await api('POST', `/api/train/bookings/${b.id}/confirm`, { as: ann, body: { passengers: people(3) } });
  assert.deepEqual([wrong.body.error.code, wrong.body.error.details.travellers], ['PASSENGERS_MISMATCH', 2]);

  const ok = await api('POST', `/api/train/bookings/${b.id}/confirm`, { as: ann, body: { passengers: people(2), contactPhone: '+91 98765 43210' } });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  const c = ok.body.booking;
  assert.equal(c.status, 'confirmed');
  assert.match(c.pnr, /^\d{10}$/);
  assert.deepEqual(c.travellers.map((x) => [x.berth, x.passenger.name]), [['B1-1', 'Traveller 1'], ['B1-2', 'Traveller 2']]);
  const again = await api('POST', `/api/train/bookings/${b.id}/confirm`, { as: ann, body: { passengers: people(2) } });
  assert.equal(again.body.booking.pnr, c.pnr, 'confirming twice: the same PNR');

  assert.equal((await api('GET', `/api/train/trips/${t.id}`)).body.trip.classes.find((x) => x.code === '3A').available, 2);
  assert.deepEqual((await api('GET', '/api/train/bookings', { as: ann })).body.bookings.map((x) => [x.id, x.pnr]), [[b.id, c.pnr]]);
  const [bob] = await users(1);
  assert.equal((await api('GET', `/api/train/bookings/${b.id}`, { as: bob })).body.error.code, 'TRAIN_BOOKING_NOT_FOUND');
});

test('holding: not enough berths → 409 with how many are left; class not offered → 400; one hold per trip; key required; admins and guests refused', async () => {
  const t = await trip();
  const [ann, bob] = await users(2);
  await hold(ann, t.id, '3A', 3);
  const short = await hold(bob, t.id, '3A', 2);
  assert.deepEqual([short.status, short.body.error.code, short.body.error.details.available], [409, 'NOT_ENOUGH_BERTHS', 1]);
  assert.equal((await hold(bob, t.id, '1A', 1)).body.error.code, 'CLASS_NOT_OFFERED');
  assert.equal((await hold(bob, t.id, 'SL', 7)).status, 400, 'more than 6 travellers');
  assert.equal((await hold(ann, t.id, 'SL', 1)).body.error.code, 'TRAIN_HOLD_EXISTS');
  assert.equal((await api('POST', `/api/train/trips/${t.id}/holds`, { as: bob, body: { classCode: 'SL', travellers: 1 } })).body.error.code, 'IDEMPOTENCY_KEY_REQUIRED');
  assert.equal((await hold(admin, t.id, 'SL', 1)).body.error.code, 'ADMINS_CANNOT_BUY');
  assert.equal((await hold(null, t.id, 'SL', 1)).status, 401);
});

test('the SAME request retried 10 times at once → one booking; a different request with that key → 422', async () => {
  const t = await trip();
  const [ann] = await users(1);
  const key = randomUUID();
  const results = await Promise.all(Array.from({ length: 10 }, () => hold(ann, t.id, 'SL', 2, key)));
  assert.equal(new Set(results.map((r) => r.body.booking?.id)).size, 1, JSON.stringify(results.map((r) => r.body)));
  assert.equal(results.filter((r) => r.status === 201).length, 1);
  assert.equal((await hold(ann, t.id, 'SL', 1, key)).body.error.code, 'IDEMPOTENCY_KEY_REUSED');
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM train_bookings WHERE trip_id = $1', [t.id])).rows[0].n, 1);
});

test('RACE: 30 people want 1 berth each, 10 berths → exactly 10 get one, all different', async () => {
  const t = await trip([{ code: 'CC', farePaise: 50_000, coaches: 2, berthsPerCoach: 5 }]);
  const crowd = await users(30);
  const results = await Promise.all(crowd.map((p) => hold(p, t.id, 'CC', 1)));
  assert.equal(results.filter((r) => r.status === 201).length, 10, JSON.stringify(results.map((r) => r.status)));
  assert.ok(results.filter((r) => r.status !== 201).every((r) => r.body.error.code === 'NOT_ENOUGH_BERTHS'));
  const berths = await activeBerths(t.id);
  assert.equal(berths.length, 10);
  assert.ok(berths.every((b) => b.n === 1), 'never one berth in two bookings');
});

test('RACE: 20 people want 2–3 berths from 20 → no berth twice, and the berths taken = what the winners hold', async () => {
  const t = await trip([{ code: 'SL', farePaise: 45_000, coaches: 4, berthsPerCoach: 5 }]);
  const crowd = await users(20);
  const wants = crowd.map((_, i) => 2 + (i % 2));
  const results = await Promise.all(crowd.map((p, i) => hold(p, t.id, 'SL', wants[i])));
  const won = results.filter((r) => r.status === 201).flatMap((r) => r.body.booking.travellers.map((x) => x.berth));
  const berths = await activeBerths(t.id);
  assert.ok(berths.every((b) => b.n === 1));
  assert.deepEqual(berths.map((b) => b.berth_label).sort(), won.sort());
  assert.ok(won.length <= 20 && won.length >= 18, `the train fills up (${won.length} of 20)`);
});

test('a hold that runs out gives its berths back and can no longer be confirmed', async () => {
  const t = await trip();
  const [ann, bob] = await users(2);
  const b = (await hold(ann, t.id, '3A', 4)).body.booking;
  await pool.query("UPDATE train_bookings SET held_until = now() - interval '1 second' WHERE id = $1", [b.id]);
  assert.equal((await api('POST', `/api/train/bookings/${b.id}/confirm`, { as: ann, body: { passengers: people(4) } })).body.error.code, 'TRAIN_HOLD_EXPIRED');
  const again = await hold(bob, t.id, '3A', 4);
  assert.equal(again.status, 201, 'all 4 berths are free again');
  assert.equal((await api('GET', `/api/train/bookings/${b.id}`, { as: ann })).body.booking.status, 'expired');
});

test('cancel: the berths go back; twice → 409; after departure → 409', async () => {
  const t = await trip();
  const [ann, bob] = await users(2);
  const b = (await hold(ann, t.id, '3A', 4)).body.booking;
  await api('POST', `/api/train/bookings/${b.id}/confirm`, { as: ann, body: { passengers: people(4) } });
  assert.equal((await api('POST', `/api/train/bookings/${b.id}/cancel`, { as: ann })).body.booking.status, 'cancelled');
  assert.equal((await api('POST', `/api/train/bookings/${b.id}/cancel`, { as: ann })).body.error.code, 'TRAIN_BOOKING_NOT_ACTIVE');
  assert.equal((await hold(bob, t.id, '3A', 4)).status, 201, 'the berths are free again');

  const gone = await trip();
  const c = (await hold(ann, gone.id, 'SL', 1)).body.booking;
  await pool.query("UPDATE train_trips SET departs_at = now() - interval '1 hour', arrives_at = now() + interval '1 hour' WHERE id = $1", [gone.id]);
  assert.equal((await api('POST', `/api/train/bookings/${c.id}/cancel`, { as: ann })).body.error.code, 'TRAIN_TRIP_DEPARTED');
  assert.equal((await hold(bob, gone.id, 'SL', 1)).body.error.code, 'TRAIN_TRIP_DEPARTED');
});

test('EXTERNAL provider: not configured → 503 on every train request, configured → 501; never invented trains; admins can\'t add local trains', async () => {
  const t = await trip();
  const [ann] = await users(1);
  const saved = { provider: env.train.provider, ...env.train.external };
  try {
    env.train.provider = 'external';
    env.train.external.url = '';
    env.train.external.apiKey = '';
    const search = await api('GET', `/api/train/trips?from=${encodeURIComponent(t.from)}&to=${encodeURIComponent(t.to)}&date=${t.date}`);
    assert.deepEqual([search.status, search.body.error.code, search.body.trips], [503, 'TRAIN_PROVIDER_NOT_CONFIGURED', undefined]);
    for (const [method, path, body] of [
      ['GET', `/api/train/trips/${t.id}`],
      ['POST', `/api/train/trips/${t.id}/holds`, { classCode: 'SL', travellers: 1 }],
      ['GET', '/api/train/bookings'],
    ]) {
      const res = await api(method, path, { as: ann, body, key: randomUUID() });
      assert.equal(res.body.error.code, 'TRAIN_PROVIDER_NOT_CONFIGURED', `${method} ${path}`);
    }
    env.train.external.url = 'https://partner.example';
    env.train.external.apiKey = 'k';
    assert.equal((await api('GET', `/api/train/trips/${t.id}`)).body.error.code, 'TRAIN_PROVIDER_NOT_IMPLEMENTED');
    const add = await api('POST', '/api/admin/train/trips', { as: admin, body: { trainNumber: '12123', trainName: `${RUN} X`, from: 'A city', to: 'B city', departsAt: new Date(Date.now() + 86_400_000).toISOString(), arrivesAt: new Date(Date.now() + 90_000_000).toISOString(), classes: [{ code: 'SL', farePaise: 1, coaches: 1, berthsPerCoach: 1 }] } });
    assert.equal(add.body.error.code, 'TRAIN_INVENTORY_EXTERNAL');
  } finally {
    env.train.provider = saved.provider;
    env.train.external.url = saved.url;
    env.train.external.apiKey = saved.apiKey;
  }
});
