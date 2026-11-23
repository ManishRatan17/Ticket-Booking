// Ticket holds over real HTTP: cookies, CSRF guard, authenticate, validation, Lua.
// Requires `docker compose up -d`.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createApp } from '../src/app.js';
import { pool } from '../src/config/db.js';
import { redis } from '../src/config/redis.js';
import { runMigrations } from '../src/db/migrate.js';
import { closeConnections } from '../src/config/connections.js';
import { stockKey } from '../src/modules/reservation/stock.js';
import { createEvent } from '../src/modules/events/events.service.js';
import { createSignedInUsers } from '../test-support/users.js';
import { createPooledClient } from '../test-support/pooled-http.js';
import { deleteEventKeys } from '../test-support/redis-cleanup.js';


const RUN = `test-holdshttp-${randomUUID().slice(0, 8)}`;
let server, baseUrl;
let n = 0;

before(async () => {
  await runMigrations({ log: () => {} });
  server = createApp().listen(0);
  baseUrl = `http://localhost:${server.address().port}`;
});

after(async () => {
  const { rows } = await pool.query('SELECT id FROM events WHERE name LIKE $1', [`${RUN}%`]);
  const ids = rows.map((r) => String(r.id));
  await deleteEventKeys(ids);
  if (ids.length) await pool.query('DELETE FROM events WHERE id = ANY($1)', [ids]);
  await pool.query('DELETE FROM users WHERE email LIKE $1', [`${RUN}%`]);
  server.close();
  await closeConnections();
});

const event = (tickets, startsInMs = -60_000) =>
  createEvent({ name: `${RUN} event ${++n}`, totalTickets: tickets, saleStartsAt: new Date(Date.now() + startsInMs) });
const users = (count) => createSignedInUsers(count, { prefix: `${RUN}-${++n}` });

async function api(method, path, { as, body, headers = {} } = {}) {
  const h = { ...headers };
  if (as) h.Cookie = as.cookie;
  if (body) h['Content-Type'] = 'application/json';
  const res = await fetch(`${baseUrl}${path}`, { method, headers: h, body: body && JSON.stringify(body) });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

const hold = (as, eventId, quantity = 1, headers) =>
  api('POST', `/api/events/${eventId}/holds`, { as, body: { quantity }, headers });
const mine = (as, eventId) => api('GET', `/api/events/${eventId}/holds/mine`, { as });
const release = (as, holdId) => api('DELETE', `/api/holds/${holdId}`, { as });
const stock = async (eventId) => Number(await redis.get(stockKey(eventId)));

// ---------- the happy path ----------

test('hold → see it → release it: stock goes down and comes back', async () => {
  const e = await event(10);
  const [ann] = await users(1);

  const created = await hold(ann, e.id, 3);
  assert.equal(created.status, 201);
  assert.equal(created.body.hold.quantity, 3);
  assert.ok(created.body.serverTime, 'serverTime lets the browser count down without trusting its own clock');
  const secondsLeft = (new Date(created.body.hold.expiresAt) - new Date(created.body.serverTime)) / 1000;
  assert.ok(secondsLeft > 295 && secondsLeft <= 300, `${secondsLeft}s left`);
  assert.equal(await stock(e.id), 7);

  assert.equal((await mine(ann, e.id)).body.hold.id, created.body.hold.id);

  assert.equal((await release(ann, created.body.hold.id)).status, 204);
  assert.equal(await stock(e.id), 10);
  assert.equal((await mine(ann, e.id)).body.hold, null);
});

// ---------- every refusal, with its code ----------

test('not signed in → 401', async () => {
  const e = await event(10);
  assert.equal((await hold(null, e.id)).status, 401);
});

test('quantity must be a JSON whole number from 1 to 4 → otherwise 400', async () => {
  const e = await event(10);
  const [ann] = await users(1);
  for (const quantity of [0, 5, 1.5, '2', null]) {
    assert.equal((await hold(ann, e.id, quantity)).status, 400, `accepted ${JSON.stringify(quantity)}`);
  }
  assert.equal(await stock(e.id), 10);
});

test('second hold for the same event → 409 HOLD_EXISTS, pointing at the first hold', async () => {
  const e = await event(10);
  const [ann] = await users(1);
  const first = await hold(ann, e.id, 2);
  const second = await hold(ann, e.id, 1);

  assert.equal(second.status, 409);
  assert.equal(second.body.error.code, 'HOLD_EXISTS');
  assert.equal(second.body.error.details.holdId, first.body.hold.id);
});

test('not enough tickets → 409 SOLD_OUT with how many are left', async () => {
  const e = await event(2);
  const [ann] = await users(1);
  const res = await hold(ann, e.id, 3);
  assert.equal(res.status, 409);
  assert.equal(res.body.error.code, 'SOLD_OUT');
  assert.equal(res.body.error.details.available, 2);
});

test('sale not started → 409 SALE_NOT_STARTED (the server decides, not the browser)', async () => {
  const e = await event(10, 3_600_000);
  const [ann] = await users(1);
  const res = await hold(ann, e.id);
  assert.equal(res.status, 409);
  assert.equal(res.body.error.code, 'SALE_NOT_STARTED');
  assert.equal(await stock(e.id), 10);
});

test('unknown event → 404', async () => {
  const [ann] = await users(1);
  assert.equal((await hold(ann, 999999999)).status, 404);
});

test('IDOR: releasing SOMEONE ELSE\'S hold → 404, and their hold is untouched', async () => {
  const e = await event(10);
  const [ann, bob] = await users(2);
  const annHold = (await hold(ann, e.id, 2)).body.hold;

  const attack = await release(bob, annHold.id);
  assert.equal(attack.status, 404);
  assert.equal(attack.body.error.code, 'HOLD_NOT_FOUND');
  assert.equal((await mine(ann, e.id)).body.hold.id, annHold.id);
  assert.equal(await stock(e.id), 8);
});

test('CSRF: a hold request started by another website → 403', async () => {
  const e = await event(10);
  const [ann] = await users(1);
  const res = await hold(ann, e.id, 1, { 'Sec-Fetch-Site': 'cross-site' });
  assert.equal(res.status, 403);
  assert.equal(await stock(e.id), 10);
});

test('an expired hold is released as soon as its owner looks at it', async () => {
  const e = await event(10);
  const [ann] = await users(1);
  const created = (await hold(ann, e.id, 4)).body.hold;
  await redis.hset(`hold:${created.id}`, 'expiresAt', Date.now() - 1000);

  assert.equal((await mine(ann, e.id)).body.hold, null);
  assert.equal(await stock(e.id), 10, 'the 4 tickets are back on sale');
});

// ---------- the headline test ----------

test('300 signed-in users race for 100 tickets over HTTP → exactly 100 holds, zero oversell', async () => {
  const e = await event(100);
  const crowd = await users(300);

  // All 300 requests are sent at once over a pool of 50 reused connections
  // (see test-support/pooled-http.js for why not 300 brand-new connections).
  const client = createPooledClient(baseUrl, { maxSockets: 50 });
  const responses = await Promise.all(
    crowd.map((u) =>
      client.request('POST', `/api/events/${e.id}/holds`, { headers: { Cookie: u.cookie }, body: { quantity: 1 } }),
    ),
  ).finally(() => client.close());
  const statuses = responses.map((r) => r.status);

  assert.equal(statuses.filter((s) => s === 201).length, 100);
  assert.equal(statuses.filter((s) => s === 409).length, 200);
  assert.ok(responses.filter((r) => r.status === 409).every((r) => r.body.error.code === 'SOLD_OUT'));
  assert.equal(await stock(e.id), 0);

  const holders = new Set(responses.filter((r) => r.status === 201).map((r) => r.body.hold.id));
  assert.equal(holders.size, 100, 'every winner got a distinct hold');
});
