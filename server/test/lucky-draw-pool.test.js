// The lucky draw, part 1: its tickets live in their OWN pool, which the normal sale can't touch.
// (The draw itself — who wins — is tested in lucky-draw.test.js.) Requires Docker.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createApp } from '../src/app.js';
import { pool } from '../src/config/db.js';
import { redis } from '../src/config/redis.js';
import { runMigrations } from '../src/db/migrate.js';
import { closeConnections } from '../src/config/connections.js';
import { createEvent, ensureStock } from '../src/modules/events/events.service.js';
import { createEventSchema } from '../src/modules/events/events.schemas.js';
import { releaseHold } from '../src/modules/reservation/holds.js';
import { stockKey, lotteryStockKey } from '../src/modules/reservation/stock.js';
import { passKey, luckyPassKey, roomKeysPattern, ACTIVE_ROOMS } from '../src/modules/waiting-room/waiting-room.js';
import { env } from '../src/config/env.js';
import { signPayload, SIGNATURE_HEADER } from '../src/modules/payments/signature.js';
import { createSignedInUsers } from '../test-support/users.js';
import { deleteEventKeys } from '../test-support/redis-cleanup.js';

const RUN = `test-lpool-${randomUUID().slice(0, 8)}`;
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
    for await (const batch of redis.scanStream({ match: roomKeysPattern(id), count: 1000 })) keys.push(...batch);
    if (keys.length) await redis.del(...keys);
    await redis.srem(ACTIVE_ROOMS, String(id));
  }
  await deleteEventKeys(createdEventIds);
  if (createdEventIds.length) {
    await pool.query('DELETE FROM sold_tickets WHERE event_id = ANY($1)', [createdEventIds]);
    await pool.query('DELETE FROM orders WHERE event_id = ANY($1)', [createdEventIds]);
    await pool.query('DELETE FROM events WHERE id = ANY($1)', [createdEventIds]);
  }
  await pool.query('DELETE FROM processed_webhooks WHERE webhook_id LIKE $1', [`${RUN}%`]);
  await pool.query('DELETE FROM users WHERE email LIKE $1', [`${RUN}%`]);
  server.close();
  await closeConnections();
});

// 10 tickets, half of them in the lucky draw → 5 normal + 5 lucky-draw.
async function event({ tickets = 10, lotteryPercent = 50, lotteryPerWinner = 2 } = {}) {
  const e = await createEvent({
    name: `${RUN} event ${++n}`,
    totalTickets: tickets,
    saleStartsAt: new Date(Date.now() - 60_000),
    admissionPerSecond: 10,
    lotteryPercent,
    lotteryPerWinner,
  });
  createdEventIds.push(e.id);
  return e;
}
const users = (count) => createSignedInUsers(count, { prefix: `${RUN}-${++n}` });
// Let people through directly (the waiting room itself has its own tests).
const admit = (e, u) => redis.set(passKey(e.id, u.id), '1', 'EX', 600);
const makeWinner = (e, u) => redis.set(luckyPassKey(e.id, u.id), '1', 'EX', 600);
const stocks = async (e) => (await redis.mget(stockKey(e.id), lotteryStockKey(e.id))).map(Number);

async function api(method, path, { as, body, headers = {} } = {}) {
  const h = { ...headers };
  if (as) h.Cookie = as.cookie;
  if (body) h['Content-Type'] = 'application/json';
  const res = await fetch(`${baseUrl}${path}`, { method, headers: h, body: body && JSON.stringify(body) });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}
const hold = (as, e, quantity) => api('POST', `/api/events/${e.id}/holds`, { as, body: { quantity } });

// ---------- settings ----------

test('settings: 20 % of 1,000 → 200 lucky-draw tickets in their own pool, 800 for the normal sale', async () => {
  const e = await event({ tickets: 1000, lotteryPercent: 20 });
  assert.deepEqual([e.lotteryPercent, e.lotteryTickets, e.lotteryDrawMinutes, e.lotteryPerWinner], [20, 200, 30, 2]);
  assert.deepEqual(await stocks(e), [800, 200]);
});

test('settings: at most 50 %, 1–4 per winner, and a draw needs a waiting room', () => {
  const base = { name: 'Concert', totalTickets: 100, saleStartsAt: '2030-01-01T10:00:00Z', admissionPerSecond: 5 };
  assert.equal(createEventSchema.parse(base).lotteryPercent, 0, 'no draw unless asked');
  assert.equal(createEventSchema.safeParse({ ...base, lotteryPercent: 51 }).success, false);
  assert.equal(createEventSchema.safeParse({ ...base, lotteryPercent: 20, lotteryPerWinner: 5 }).success, false);
  const noRoom = createEventSchema.safeParse({ ...base, admissionPerSecond: null, lotteryPercent: 20 });
  assert.equal(noRoom.success, false);
  assert.deepEqual(noRoom.error.issues[0].path, ['lotteryPercent']);
});

// ---------- the normal sale can't touch the draw's tickets ----------

test('the normal sale sells only its own 5: the 6th → SOLD_OUT while the 5 lucky-draw tickets stay untouched', async () => {
  const e = await event();
  const [a, b, c] = await users(3);
  for (const u of [a, b, c]) await admit(e, u);

  assert.equal((await hold(a, e, 4)).status, 201);
  assert.equal((await hold(b, e, 1)).status, 201);
  const third = await hold(c, e, 1);
  assert.equal(third.status, 409);
  assert.equal(third.body.error.code, 'SOLD_OUT');
  assert.deepEqual(await stocks(e), [0, 5]);
});

test('a lucky-draw WINNER holds from the draw\'s pool (no waiting-room pass needed), up to the per-winner limit', async () => {
  const e = await event();
  const [winner, normal] = await users(2);
  await makeWinner(e, winner);

  const tooMany = await hold(winner, e, 3);
  assert.equal(tooMany.status, 409);
  assert.equal(tooMany.body.error.code, 'LUCKY_DRAW_LIMIT');
  assert.deepEqual(tooMany.body.error.details, { limit: 2 });

  const won = await hold(winner, e, 2);
  assert.equal(won.status, 201);
  assert.equal(won.body.hold.pool, 'lottery');
  assert.deepEqual(await stocks(e), [5, 3], 'taken from the lucky-draw pool only');

  // Someone without a lucky pass (and without a waiting-room pass) is still turned away.
  assert.equal((await hold(normal, e, 1)).body.error.code, 'NOT_ADMITTED');
});

test('released or expired lucky-draw tickets go back to the DRAW\'s pool, not the normal sale', async () => {
  const e = await event();
  const [winner] = await users(1);
  await makeWinner(e, winner);
  const h = (await hold(winner, e, 2)).body.hold;
  assert.deepEqual(await stocks(e), [5, 3]);

  assert.equal(await releaseHold(h.id), 'released'); // as the expiry worker does
  assert.deepEqual(await stocks(e), [5, 5]);
});

test('an expired lucky-draw hold, replaced by a normal hold: its tickets go back to the draw\'s pool', async () => {
  const e = await event();
  const [u] = await users(1);
  await makeWinner(e, u);
  const h = (await hold(u, e, 2)).body.hold;
  await redis.hset(`hold:${h.id}`, 'expiresAt', Date.now() - 1000); // its time ran out

  await redis.del(luckyPassKey(e.id, u.id)); // the win is over; now a normal buyer let in by the line
  await admit(e, u);
  assert.equal((await hold(u, e, 1)).body.hold.pool, 'main');
  assert.deepEqual(await stocks(e), [4, 5], 'the 2 lucky tickets went back to the draw, the new 1 came from the normal sale');
});

// ---------- orders and rebuilding from PostgreSQL ----------

async function payFor(as, holdId) {
  const order = (await api('POST', '/api/orders', { as, body: { holdId }, headers: { 'Idempotency-Key': randomUUID() } })).body.order;
  const event = {
    id: `${RUN}-evt-${randomUUID()}`,
    type: 'payment.succeeded',
    data: { orderId: order.id, paymentId: `pay_${randomUUID()}`, amountPaise: order.amountPaise },
  };
  await fetch(`${baseUrl}/api/webhooks/payments`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', [SIGNATURE_HEADER]: signPayload(JSON.stringify(event), env.payments.webhookSecret) },
    body: JSON.stringify(event),
  });
  return order;
}

test('orders remember their pool; when Redis loses both pools, each is rebuilt correctly from PostgreSQL', async () => {
  const e = await event();
  const [winner, buyer] = await users(2);
  await makeWinner(e, winner);
  await admit(e, buyer);

  const lucky = await payFor(winner, (await hold(winner, e, 2)).body.hold.id);
  assert.equal(lucky.pool, 'lottery');
  const normal = await payFor(buyer, (await hold(buyer, e, 3)).body.hold.id);
  assert.equal(normal.pool, 'main');
  assert.deepEqual(await stocks(e), [2, 3]);

  await redis.del(stockKey(e.id), lotteryStockKey(e.id)); // as if Redis restarted without its data
  await ensureStock(e);
  assert.deepEqual(await stocks(e), [2, 3], 'normal = 10 − 5 sold − 3 still in the draw; draw = 5 − 2 sold from it');
});
