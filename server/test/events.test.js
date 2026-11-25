// Events: admin creation, public reading, and rebuilding Redis stock from Postgres.
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
import { createSignedInUsers } from '../test-support/users.js';
import { deleteEventKeys } from '../test-support/redis-cleanup.js';


const RUN = `test-events-${randomUUID().slice(0, 8)}`;
let server, baseUrl, admin, user, releaseAdminsLock;

before(async () => {
  await runMigrations({ log: () => {} });
  server = createApp().listen(0);
  baseUrl = `http://localhost:${server.address().port}`;
  const { holdWhileCreatingAdmins } = await import('../test-support/admin-lock.js');
  releaseAdminsLock = await holdWhileCreatingAdmins(); // see admin-lock.js
  [admin] = await createSignedInUsers(1, { prefix: `${RUN}-admin`, role: 'admin' });
  [user] = await createSignedInUsers(1, { prefix: `${RUN}-user` });
});

after(async () => {
  const { rows } = await pool.query('SELECT id FROM events WHERE name LIKE $1', [`${RUN}%`]);
  const ids = rows.map((r) => r.id);
  if (ids.length) {
    await pool.query('DELETE FROM sold_tickets WHERE event_id = ANY($1)', [ids]);
    await pool.query('DELETE FROM orders WHERE event_id = ANY($1)', [ids]);
    await pool.query('DELETE FROM events WHERE id = ANY($1)', [ids]);
    // Every Redis key of these events: stock, holds (the rebuild-race test makes 10), index entries.
    await deleteEventKeys(ids);
  }
  await pool.query('DELETE FROM users WHERE email LIKE $1', [`${RUN}%`]);
  await releaseAdminsLock?.(); // our admin is gone
  server.close();
  await closeConnections();
});

async function api(method, path, { as, body } = {}) {
  const headers = {};
  if (as) headers.Cookie = as.cookie;
  if (body) headers['Content-Type'] = 'application/json';
  const res = await fetch(`${baseUrl}${path}`, { method, headers, body: body && JSON.stringify(body) });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

const newEvent = (overrides = {}) =>
  api('POST', '/api/admin/events', {
    as: admin,
    body: { name: `${RUN} concert`, totalTickets: 100, saleStartsAt: new Date(Date.now() - 60_000).toISOString(), ...overrides },
  });

// ---------- creating ----------

test('admin creates an event: saved in Postgres, stock loaded into Redis', async () => {
  const { status, body } = await newEvent({ totalTickets: 250 });
  assert.equal(status, 201);
  assert.equal(body.event.totalTickets, 250);
  assert.equal(body.event.available, 250);
  assert.equal(body.event.onSale, true);

  const { rows } = await pool.query('SELECT total_tickets FROM events WHERE id = $1', [body.event.id]);
  assert.equal(rows[0].total_tickets, 250);
  assert.equal(await redis.get(stockKey(body.event.id)), '250');
});

test('only admins can create events (normal user → 403, nobody → 401)', async () => {
  assert.equal((await api('POST', '/api/admin/events', { as: user, body: { name: 'x' } })).status, 403);
  assert.equal((await api('POST', '/api/admin/events', { body: { name: 'x' } })).status, 401);
});

test('invalid event data → 400 with the field names', async () => {
  const { status, body } = await api('POST', '/api/admin/events', {
    as: admin,
    body: { name: 'ab', totalTickets: 0, saleStartsAt: 'next tuesday' },
  });
  assert.equal(status, 400);
  const fields = body.error.details.map((d) => d.field).sort();
  assert.deepEqual(fields, ['body.name', 'body.saleStartsAt', 'body.totalTickets']);
});

// ---------- reading ----------

test('anyone can list events and see one, with live tickets left and the server time', async () => {
  const created = (await newEvent()).body.event;

  const list = await api('GET', '/api/events');
  assert.equal(list.status, 200);
  assert.ok(list.body.events.some((e) => e.id === created.id));
  assert.ok(Math.abs(new Date(list.body.serverTime) - Date.now()) < 5000, 'serverTime should be "now"');

  const one = await api('GET', `/api/events/${created.id}`);
  assert.equal(one.status, 200);
  assert.equal(one.body.event.available, 100);
});

test('a future event is listed but not on sale yet', async () => {
  const future = (await newEvent({ saleStartsAt: new Date(Date.now() + 3_600_000).toISOString() })).body.event;
  assert.equal(future.onSale, false);
});

test('unknown event → 404, non-numeric id → 400', async () => {
  assert.equal((await api('GET', '/api/events/999999999')).status, 404);
  assert.equal((await api('GET', '/api/events/abc')).status, 400);
});

// ---------- Redis loses the stock: rebuild from Postgres ----------

test('Redis lost the stock → rebuilt as total − sold, from Postgres', async () => {
  const event = (await newEvent({ totalTickets: 10 })).body.event;

  // Pretend 3 tickets were already SOLD (paid orders live in Postgres — Phase 2).
  const [buyer] = await createSignedInUsers(1, { prefix: `${RUN}-buyer` });
  const order = await pool.query(
    `INSERT INTO orders (user_id, event_id, quantity, status, idempotency_key, expires_at)
     VALUES ($1, $2, 3, 'paid', 'k', now()) RETURNING id`,
    [buyer.id, event.id],
  );
  await pool.query(
    `INSERT INTO sold_tickets (event_id, ticket_number, order_id) VALUES ($1, 1, $2), ($1, 2, $2), ($1, 3, $2)`,
    [event.id, order.rows[0].id],
  );

  await redis.del(stockKey(event.id)); // Redis "restarted empty"
  const after = await api('GET', `/api/events/${event.id}`);
  assert.equal(after.body.event.available, 7);
});

test('rebuild race: 30 requests notice the missing stock at once → rebuilt exactly once', async () => {
  const event = (await newEvent({ totalTickets: 40 })).body.event;
  await redis.del(stockKey(event.id));

  // Requests that rebuild AND requests that hold, all at once. With a plain SET, a late
  // rebuild could overwrite the stock after holds took tickets (tickets out of nothing).
  const holders = await createSignedInUsers(10, { prefix: `${RUN}-race` });
  await Promise.all([
    ...Array.from({ length: 20 }, () => api('GET', `/api/events/${event.id}`)),
    ...holders.map((h) => api('POST', `/api/events/${event.id}/holds`, { as: h, body: { quantity: 1 } })),
  ]);

  assert.equal(await redis.get(stockKey(event.id)), '30', '40 total − 10 held');
});
