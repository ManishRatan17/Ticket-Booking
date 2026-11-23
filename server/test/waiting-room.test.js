// The waiting room: fair order, one place per person, steady admission, passes. Requires Docker.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createApp } from '../src/app.js';
import { pool } from '../src/config/db.js';
import { redis } from '../src/config/redis.js';
import { runMigrations } from '../src/db/migrate.js';
import { closeConnections } from '../src/config/connections.js';
import { createEvent } from '../src/modules/events/events.service.js';
import { admitWaiting } from '../src/jobs/processors.js';
import { ACTIVE_ROOMS } from '../src/modules/waiting-room/waiting-room.js';
import { createSignedInUsers } from '../test-support/users.js';
import { createPooledClient } from '../test-support/pooled-http.js';
import { deleteEventKeys } from '../test-support/redis-cleanup.js';

const RUN = `test-wroom-${randomUUID().slice(0, 8)}`;
let server, baseUrl;
let n = 0;
const createdEventIds = [];

before(async () => {
  await runMigrations({ log: () => {} });
  server = createApp().listen(0);
  baseUrl = `http://localhost:${server.address().port}`;
});

after(async () => {
  for (const id of createdEventIds) {
    const keys = [];
    for await (const batch of redis.scanStream({ match: `wr:${id}:*`, count: 1000 })) keys.push(...batch);
    if (keys.length) await redis.del(...keys);
    await redis.srem(ACTIVE_ROOMS, String(id));
  }
  await deleteEventKeys(createdEventIds);
  if (createdEventIds.length) await pool.query('DELETE FROM events WHERE id = ANY($1)', [createdEventIds]);
  await pool.query('DELETE FROM users WHERE email LIKE $1', [`${RUN}%`]);
  server.close();
  await closeConnections();
});

async function event({ rate = 2, tickets = 100, startsInMs = -60_000 } = {}) {
  const e = await createEvent({
    name: `${RUN} event ${++n}`,
    totalTickets: tickets,
    saleStartsAt: new Date(Date.now() + startsInMs),
    admissionPerSecond: rate,
  });
  createdEventIds.push(e.id);
  return e;
}
const users = (count) => createSignedInUsers(count, { prefix: `${RUN}-${++n}` });

async function api(method, path, { as, body } = {}) {
  const headers = {};
  if (as) headers.Cookie = as.cookie;
  if (body) headers['Content-Type'] = 'application/json';
  const res = await fetch(`${baseUrl}${path}`, { method, headers, body: body && JSON.stringify(body) });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}
const join = (as, eventId) => api('POST', `/api/events/${eventId}/queue`, { as });
const status = (as, eventId) => api('GET', `/api/events/${eventId}/queue`, { as });
const hold = (as, eventId) => api('POST', `/api/events/${eventId}/holds`, { as, body: { quantity: 1 } });

// ---------- the gate ----------

test('waiting-room event: holding WITHOUT being let in → 403 NOT_ADMITTED', async () => {
  const e = await event();
  const [ann] = await users(1);
  const res = await hold(ann, e.id);
  assert.equal(res.status, 403);
  assert.equal(res.body.error.code, 'NOT_ADMITTED');
});

test('an event WITHOUT a waiting room: joining → 409, holding works directly (unchanged)', async () => {
  const e = await createEvent({ name: `${RUN} open`, totalTickets: 10, saleStartsAt: new Date(Date.now() - 60_000) });
  createdEventIds.push(e.id);
  const [ann] = await users(1);
  assert.equal((await join(ann, e.id)).body.error.code, 'NO_WAITING_ROOM');
  assert.equal((await hold(ann, e.id)).status, 201);
});

// ---------- joining ----------

test('joining: positions in arrival order; re-joining (another tab) keeps your place', async () => {
  const e = await event();
  const [ann, bob] = await users(2);

  const a = (await join(ann, e.id)).body;
  const b = (await join(bob, e.id)).body;
  assert.deepEqual([a.status, a.position], ['waiting', 1]);
  assert.deepEqual([b.position, b.total], [2, 2]);

  const again = (await join(ann, e.id)).body; // second tab / reload
  assert.equal(again.position, 1, 'still first');
  assert.equal(again.total, 2, 'no second place created');
  assert.ok(again.estimatedWaitSeconds >= 1);
});

test('race: 300 people join at the same instant → positions exactly 1–300, nobody twice', async () => {
  const e = await event();
  const crowd = await users(300);
  const client = createPooledClient(baseUrl, { maxSockets: 50 });
  const results = await Promise.all(
    crowd.map((u) => client.request('POST', `/api/events/${e.id}/queue`, { headers: { Cookie: u.cookie } })),
  ).finally(() => client.close());

  const positions = results.map((r) => r.body.position).sort((x, y) => x - y);
  assert.deepEqual(positions, Array.from({ length: 300 }, (_, i) => i + 1));
});

// ---------- admission ----------

test('admission: N per tick, in arrival order; everyone behind moves up', async () => {
  const e = await event({ rate: 2 });
  const [first, second, third] = await users(3);
  for (const u of [first, second, third]) await join(u, e.id);

  await admitWaiting(); // one tick of the admission worker

  assert.equal((await status(first, e.id)).body.status, 'admitted');
  assert.equal((await status(second, e.id)).body.status, 'admitted');
  const third_ = (await status(third, e.id)).body;
  assert.deepEqual([third_.status, third_.position], ['waiting', 1], 'third person is now next');
});

test('admitted: holding works, and the pass lasts 10 minutes', async () => {
  const e = await event({ rate: 5 });
  const [ann] = await users(1);
  await join(ann, e.id);
  await admitWaiting();

  const s = (await status(ann, e.id)).body;
  assert.equal(s.status, 'admitted');
  assert.ok(s.passExpiresInSeconds > 590 && s.passExpiresInSeconds <= 600);
  assert.equal((await hold(ann, e.id)).status, 201);
  assert.equal((await join(ann, e.id)).body.status, 'admitted', 'joining again keeps the pass');
});

test('the lobby: before the sale opens people can queue, but nobody is let in yet', async () => {
  const e = await event({ rate: 10, startsInMs: 3_600_000 });
  const [ann] = await users(1);
  const joined = (await join(ann, e.id)).body;
  assert.equal(joined.status, 'waiting');
  assert.ok(joined.estimatedWaitSeconds > 3500, 'the estimate includes the time until the sale');

  await admitWaiting();
  assert.equal((await status(ann, e.id)).body.status, 'waiting');
});

test('fairness under load: 300 in line, rate 50 → 6 ticks admit everyone, strictly in arrival order', async () => {
  const e = await event({ rate: 50 });
  const crowd = await users(300);
  for (const u of crowd) await join(u, e.id); // sequential: arrival order = array order

  const passKey = (u) => `wr:${e.id}:pass:${u.id}`;
  for (let tick = 1; tick <= 6; tick++) {
    await admitWaiting();
    const admittedNow = await Promise.all(crowd.map(async (u) => (await redis.exists(passKey(u))) === 1));
    const count = admittedNow.filter(Boolean).length;
    assert.equal(count, Math.min(300, tick * 50), `tick ${tick}`);
    // Exactly the FIRST `count` people are in — nobody overtook anybody.
    assert.ok(admittedNow.every((isIn, i) => isIn === i < count), `order broken at tick ${tick}`);
  }
  assert.equal(await redis.sismember(ACTIVE_ROOMS, String(e.id)), 0, 'empty room is no longer checked');
});

test('two admission runs at the same moment never let in more than 2 × N, or anyone twice', async () => {
  const e = await event({ rate: 3 });
  const crowd = await users(10);
  for (const u of crowd) await join(u, e.id);

  await Promise.all([admitWaiting(), admitWaiting()]);
  const passes = await Promise.all(crowd.map((u) => redis.exists(`wr:${e.id}:pass:${u.id}`)));
  assert.equal(passes.filter((x) => x === 1).length, 6);
  assert.equal(Number(await redis.zcard(`wr:${e.id}:queue`)), 4);
});

test('not signed in → 401; unknown event → 404', async () => {
  assert.equal((await api('POST', '/api/events/1/queue')).status, 401);
  const [ann] = await users(1);
  assert.equal((await join(ann, 999999999)).status, 404);
});
