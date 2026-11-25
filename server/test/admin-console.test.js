// The admin side: admins don't buy or ask for help, Manage events (live numbers, editing),
// and notifications about new bot strikes. Requires Docker.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createApp } from '../src/app.js';
import { env } from '../src/config/env.js';
import { pool } from '../src/config/db.js';
import { runMigrations } from '../src/db/migrate.js';
import { closeConnections } from '../src/config/connections.js';
import { createEvent } from '../src/modules/events/events.service.js';
import { strike } from '../src/modules/moderation/moderation.service.js';
import { signPayload, SIGNATURE_HEADER } from '../src/modules/payments/signature.js';
import { createSignedInUsers } from '../test-support/users.js';
import { deleteEventKeys } from '../test-support/redis-cleanup.js';
import { holdWhileCreatingAdmins } from '../test-support/admin-lock.js';

const RUN = `test-adminc-${randomUUID().slice(0, 8)}`;
let server, baseUrl, admin, releaseAdminsLock;
let n = 0;
const createdEventIds = [];

before(async () => {
  await runMigrations({ log: () => {} });
  server = createApp().listen(0);
  baseUrl = `http://localhost:${server.address().port}`;
  releaseAdminsLock = await holdWhileCreatingAdmins();
  [admin] = await createSignedInUsers(1, { prefix: `${RUN}-admin`, role: 'admin' });
});

after(async () => {
  try {
    await deleteEventKeys(createdEventIds);
    if (createdEventIds.length) {
      await pool.query('DELETE FROM sold_tickets WHERE event_id = ANY($1)', [createdEventIds]);
      await pool.query('DELETE FROM orders WHERE event_id = ANY($1)', [createdEventIds]);
      await pool.query('DELETE FROM events WHERE id = ANY($1)', [createdEventIds]);
    }
    await pool.query('DELETE FROM processed_webhooks WHERE webhook_id LIKE $1', [`${RUN}%`]);
    await pool.query('DELETE FROM users WHERE email LIKE $1', [`${RUN}%`]);
  } finally {
    await releaseAdminsLock?.();
    server.close();
    await closeConnections();
  }
});

async function event(extra = {}) {
  const e = await createEvent({ name: `${RUN} event ${++n}`, totalTickets: 10, pricePaise: 50_000, saleStartsAt: new Date(Date.now() - 60_000), ...extra });
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
const hold = (as, e, quantity = 1) => api('POST', `/api/events/${e.id}/holds`, { as, body: { quantity } });

async function buy(as, e, quantity) {
  const h = (await hold(as, e, quantity)).body.hold;
  const order = (await api('POST', '/api/orders', { as, body: { holdId: h.id }, headers: { 'Idempotency-Key': randomUUID() } })).body.order;
  const evt = { id: `${RUN}-evt-${randomUUID()}`, type: 'payment.succeeded', data: { orderId: order.id, paymentId: `pay_${randomUUID()}`, amountPaise: order.amountPaise } };
  await fetch(`${baseUrl}/api/webhooks/payments`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', [SIGNATURE_HEADER]: signPayload(JSON.stringify(evt), env.payments.webhookSecret) },
    body: JSON.stringify(evt),
  });
}

// ---------- admins run the sale, they don't take part ----------

test('admins can\'t buy: hold, join a queue, order and pay → 403 ADMINS_CANNOT_BUY', async () => {
  const e = await event();
  const room = await event({ admissionPerSecond: 5 });
  for (const [path, body] of [
    [`/api/events/${e.id}/holds`, { quantity: 1 }],
    [`/api/events/${room.id}/queue`, undefined],
    ['/api/orders', { holdId: randomUUID() }],
    ['/api/payments/fake/1', { outcome: 'success' }],
  ]) {
    const res = await api('POST', path, { as: admin, body });
    assert.equal(res.status, 403, path);
    assert.equal(res.body.error.code, 'ADMINS_CANNOT_BUY');
  }
  const [ann] = await users(1);
  assert.equal((await hold(ann, e)).status, 201, 'normal people still can');
});

test('admins don\'t send support requests (they answer them) → 403 ADMINS_USE_INBOX', async () => {
  const res = await api('POST', '/api/support/requests', { as: admin, body: { kind: 'question', message: 'hello' } });
  assert.equal(res.status, 403);
  assert.equal(res.body.error.code, 'ADMINS_USE_INBOX');
});

// ---------- Manage events ----------

test('Manage events: live numbers per event — sold, held, available, revenue, status', async () => {
  const e = await event();
  const [ann, bob] = await users(2);
  await buy(ann, e, 3); // 3 sold
  await hold(bob, e, 2); // 2 held
  await new Promise((r) => setTimeout(r, 100));

  const list = (await api('GET', '/api/admin/events', { as: admin })).body.events;
  const mine = list.find((x) => x.id === e.id);
  assert.deepEqual(
    [mine.status, mine.sold, mine.held, mine.available, mine.revenuePaise, mine.paidOrders],
    ['on_sale', 3, 2, 5, 150_000, 1],
  );
  const one = (await api('GET', `/api/admin/events/${e.id}`, { as: admin })).body.event;
  assert.equal(one.sold, 3);
});

test('statuses: upcoming, all held, sold out', async () => {
  const soon = await event({ saleStartsAt: new Date(Date.now() + 3_600_000) });
  const small = await event({ totalTickets: 2 });
  const [ann, bob] = await users(2);
  await hold(ann, small, 2);
  const status = async (e) => (await api('GET', `/api/admin/events/${e.id}`, { as: admin })).body.event.status;
  assert.equal(await status(soon), 'upcoming');
  assert.equal(await status(small), 'all_held');
  const tiny = await event({ totalTickets: 1 });
  await buy(bob, tiny, 1);
  assert.equal(await status(tiny), 'sold_out');
});

test('editing BEFORE the sale: price, sale time and waiting room change — and the shop sees it at once', async () => {
  const e = await event({ saleStartsAt: new Date(Date.now() + 3_600_000) });
  const later = new Date(Date.now() + 7_200_000).toISOString();
  const res = await api('PATCH', `/api/admin/events/${e.id}`, {
    as: admin,
    body: { name: `${RUN} renamed`, pricePaise: 99_900, saleStartsAt: later, admissionPerSecond: 20 },
  });
  assert.equal(res.status, 200);
  const shop = (await api('GET', `/api/events/${e.id}`)).body.event;
  assert.deepEqual([shop.name, shop.pricePaise, shop.saleStartsAt, shop.admissionPerSecond], [`${RUN} renamed`, 99_900, later, 20]);
});

test('editing AFTER the sale opened: only the name (price or time → 409 SALE_STARTED)', async () => {
  const e = await event();
  const price = await api('PATCH', `/api/admin/events/${e.id}`, { as: admin, body: { pricePaise: 1 } });
  assert.equal(price.status, 409);
  assert.equal(price.body.error.code, 'SALE_STARTED');
  assert.equal((await api('PATCH', `/api/admin/events/${e.id}`, { as: admin, body: { name: `${RUN} new name` } })).status, 200);
});

test('editing: a lucky draw keeps its waiting room; validation; admins only', async () => {
  const e = await event({ saleStartsAt: new Date(Date.now() + 3_600_000), admissionPerSecond: 5, lotteryPercent: 20 });
  assert.equal((await api('PATCH', `/api/admin/events/${e.id}`, { as: admin, body: { admissionPerSecond: null } })).body.error.code, 'LOTTERY_NEEDS_ROOM');
  assert.equal((await api('PATCH', `/api/admin/events/${e.id}`, { as: admin, body: {} })).status, 400);
  assert.equal((await api('PATCH', `/api/admin/events/${e.id}`, { as: admin, body: { pricePaise: -5 } })).status, 400);
  const [ann] = await users(1);
  assert.equal((await api('PATCH', `/api/admin/events/${e.id}`, { as: ann, body: { name: 'hack' } })).status, 403);
  assert.equal((await api('GET', '/api/admin/events', { as: ann })).status, 403);
});

// ---------- notifications ----------

test('a NEW bot strike shows up for admins (with the email) until an admin marks it as seen', async () => {
  // Start from a clean slate: earlier strikes in this database are "seen".
  await api('POST', '/api/admin/restrictions/acknowledge', { as: admin });
  const [bot, other] = await users(2);
  await strike(bot.id, { reason: 'Automated (bot-like) activity', evidence: { score: 20, signals: { rate_limited: 20 } } });

  const note = (await api('GET', '/api/admin/notifications', { as: admin })).body;
  assert.equal(note.count, 1);
  assert.equal(note.latest[0].userEmail, bot.email);
  assert.deepEqual(note.latest[0].evidence.signals, { rate_limited: 20 });

  // A restriction made BY an admin is not "new" to the admins.
  await api('POST', '/api/admin/restrictions', { as: admin, body: { email: other.email, kind: 'suspended', reason: 'by hand' } });
  assert.equal((await api('GET', '/api/admin/notifications', { as: admin })).body.count, 1);

  const ack = await api('POST', '/api/admin/restrictions/acknowledge', { as: admin });
  assert.equal(ack.body.acknowledged, 1);
  assert.equal((await api('GET', '/api/admin/notifications', { as: admin })).body.count, 0);
  const list = (await api('GET', '/api/admin/restrictions', { as: admin })).body.restrictions;
  assert.ok(list.find((r) => r.userEmail === bot.email).acknowledgedAt);
  assert.equal((await api('GET', '/api/admin/notifications', { as: bot })).status, 403);
});
