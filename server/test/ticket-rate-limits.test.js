// Phase 5a: rate limits on the ticket path (holds, queue, orders, payments). Requires Docker.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

// .env.test switches rate limits OFF for the rest of the suite; this file turns them back ON with
// its own Redis prefix, and trusts the loopback proxy so each test can be a different IP
// (X-Forwarded-For). Set BEFORE the app is imported: env.js reads process.env once.
const PREFIX = `ratelimit-test-${randomUUID().slice(0, 8)}`;
Object.assign(process.env, { RATE_LIMITS_ENABLED: 'true', RATE_LIMIT_PREFIX: PREFIX, TRUST_PROXY: 'loopback' });

const { createApp } = await import('../src/app.js');
const { pool } = await import('../src/config/db.js');
const { redis } = await import('../src/config/redis.js');
const { runMigrations } = await import('../src/db/migrate.js');
const { closeConnections } = await import('../src/config/connections.js');
const { createEvent } = await import('../src/modules/events/events.service.js');
const { createSignedInUsers } = await import('../test-support/users.js');
const { createPooledClient } = await import('../test-support/pooled-http.js');
const { deleteEventKeys } = await import('../test-support/redis-cleanup.js');

await runMigrations({ log: () => {} });
const server = createApp().listen(0);
const baseUrl = `http://localhost:${server.address().port}`;
const http = createPooledClient(baseUrl);

const RUN = `test-ticketrl-${randomUUID().slice(0, 8)}`;
let n = 0;
const newIp = () => `203.0.113.${++n}`; // a documentation-only IP range: never a real client
const users = (count) => createSignedInUsers(count, { prefix: `${RUN}-${++n}` });
const createdEventIds = [];

after(async () => {
  await deleteEventKeys(createdEventIds);
  if (createdEventIds.length) await pool.query('DELETE FROM events WHERE id = ANY($1)', [createdEventIds]);
  await pool.query('DELETE FROM users WHERE email LIKE $1', [`${RUN}%`]);
  const keys = await redis.keys(`${PREFIX}:*`);
  if (keys.length) await redis.del(...keys);
  http.close();
  server.close();
  await closeConnections();
});

async function event(extra = {}) {
  const e = await createEvent({
    name: `${RUN} event ${++n}`,
    totalTickets: 10_000,
    saleStartsAt: new Date(Date.now() - 60_000),
    ...extra,
  });
  createdEventIds.push(e.id);
  return e;
}

const send = (method, path, { as, ip, body, headers = {} }) =>
  http.request(method, path, { headers: { Cookie: as.cookie, 'X-Forwarded-For': ip, ...headers }, body });
const hold = (as, ip, eventId) => send('POST', `/api/events/${eventId}/holds`, { as, ip, body: { quantity: 1 } });

// ---------- holds ----------

test('holds, per USER: 10 attempts a minute, the 11th → 429 with Retry-After; others are unaffected', async () => {
  const e = await event();
  const ip = newIp();
  const [ann, bob] = await users(2);

  const statuses = [];
  for (let i = 0; i < 10; i++) statuses.push((await hold(ann, ip, e.id)).status);
  assert.equal(statuses[0], 201); // the first one holds…
  assert.ok(statuses.slice(1).every((s) => s === 409), 'the rest: HOLD_EXISTS — still counted'); // …the rest are refused

  // Raw fetch here, to see the headers.
  const blocked = await fetch(`${baseUrl}/api/events/${e.id}/holds`, {
    method: 'POST',
    headers: { Cookie: ann.cookie, 'X-Forwarded-For': ip, 'Content-Type': 'application/json' },
    body: JSON.stringify({ quantity: 1 }),
  });
  assert.equal(blocked.status, 429);
  assert.equal((await blocked.json()).error.code, 'RATE_LIMITED');
  const retryAfter = Number(blocked.headers.get('retry-after'));
  assert.ok(retryAfter > 0 && retryAfter <= 60, `Retry-After was ${retryAfter}`);

  // Bob, on the SAME IP, has his own budget.
  assert.equal((await hold(bob, ip, e.id)).status, 201);
});

test('holds, per IP: 13 accounts × 10 requests from ONE IP, all at once → exactly 120 get through', async () => {
  const e = await event();
  const ip = newIp();
  const crowd = await users(13); // each stays under its own limit of 10

  const results = await Promise.all(crowd.flatMap((u) => Array.from({ length: 10 }, () => hold(u, ip, e.id))));
  const limited = results.filter((r) => r.status === 429).length;
  assert.equal(limited, 10, '130 requests − 120 allowed by the IP limit');

  // Another IP is not affected by this one being blocked.
  const [carol] = await users(1);
  assert.equal((await hold(carol, newIp(), e.id)).status, 201);
});

test('release, per user: 20 a minute', async () => {
  const ip = newIp();
  const [ann] = await users(1);
  for (let i = 0; i < 20; i++) {
    assert.equal((await send('DELETE', `/api/holds/${randomUUID()}`, { as: ann, ip })).status, 404);
  }
  assert.equal((await send('DELETE', `/api/holds/${randomUUID()}`, { as: ann, ip })).status, 429);
});

// ---------- waiting room ----------

test('queue join: 10 per user a minute; status (polled) gets 60', async () => {
  const e = await event({ admissionPerSecond: 1 });
  const ip = newIp();
  const [ann] = await users(1);
  const join = () => send('POST', `/api/events/${e.id}/queue`, { as: ann, ip });
  const status = () => send('GET', `/api/events/${e.id}/queue`, { as: ann, ip });

  for (let i = 0; i < 10; i++) assert.equal((await join()).status, 200);
  assert.equal((await join()).status, 429);

  // Status has its OWN, bigger budget (joining used none of it).
  const polls = await Promise.all(Array.from({ length: 61 }, status));
  assert.equal(polls.filter((r) => r.status === 200).length, 60);
  assert.equal(polls.filter((r) => r.status === 429).length, 1);
});

test('queue join, per IP: 60 a minute across accounts', async () => {
  const e = await event({ admissionPerSecond: 1 });
  const ip = newIp();
  const crowd = await users(7); // 7 × 9 = 63 joins, each account under its own 10
  const results = await Promise.all(
    crowd.flatMap((u) => Array.from({ length: 9 }, () => send('POST', `/api/events/${e.id}/queue`, { as: u, ip }))),
  );
  assert.equal(results.filter((r) => r.status === 429).length, 3);
});

// ---------- checkout ----------

test('orders and fake payments: 10 per user a minute each', async () => {
  const ip = newIp();
  const [ann] = await users(1);

  // No Idempotency-Key → 400, but the attempt still counts (the limit runs first).
  for (let i = 0; i < 10; i++) {
    assert.equal((await send('POST', '/api/orders', { as: ann, ip, body: { holdId: randomUUID() } })).status, 400);
  }
  assert.equal((await send('POST', '/api/orders', { as: ann, ip, body: { holdId: randomUUID() } })).status, 429);

  const pay = () => send('POST', '/api/payments/fake/999999999', { as: ann, ip, body: { outcome: 'success' } });
  for (let i = 0; i < 10; i++) assert.equal((await pay()).status, 404);
  assert.equal((await pay()).status, 429);
});

test('not signed in: a flood is answered 401 by authenticate, and does not use anyone’s budget', async () => {
  const e = await event();
  const ip = newIp();
  const anon = { cookie: '' };
  for (let i = 0; i < 15; i++) assert.equal((await hold(anon, ip, e.id)).status, 401);
  // The IP budget (120) is used a little; no user budget exists for anonymous requests.
  const [ann] = await users(1);
  assert.equal((await hold(ann, ip, e.id)).status, 201);
});
