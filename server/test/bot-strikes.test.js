// Phase 5e: bot signals → strikes → suspension (15 days) → ban (second strike). Requires Docker.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { startFakeTurnstile } from '../test-support/fake-turnstile.js';

// The general suite runs with rate limits, the bot check and moderation OFF. This file switches all
// three on, with its own Redis prefixes and a fake Cloudflare. Set BEFORE the app is imported.
const ID = randomUUID().slice(0, 8);
const cloudflare = await startFakeTurnstile({ secret: 'strike-test-secret' });
Object.assign(process.env, {
  RATE_LIMITS_ENABLED: 'true',
  RATE_LIMIT_PREFIX: `ratelimit-strikes-${ID}`,
  MODERATION_ENABLED: 'true',
  MODERATION_PREFIX: `bot-test-${ID}`,
  TURNSTILE_SITE_KEY: 'test-site-key',
  TURNSTILE_SECRET_KEY: 'strike-test-secret',
  TURNSTILE_VERIFY_URL: cloudflare.url,
  TRUST_PROXY: 'loopback',
});

const { createApp } = await import('../src/app.js');
const { pool } = await import('../src/config/db.js');
const { redis } = await import('../src/config/redis.js');
const { runMigrations } = await import('../src/db/migrate.js');
const { closeConnections } = await import('../src/config/connections.js');
const { createEvent } = await import('../src/modules/events/events.service.js');
const { stockKey } = await import('../src/modules/reservation/stock.js');
const { strike, keys } = await import('../src/modules/moderation/moderation.service.js');
const { queueKey, roomKeysPattern, ACTIVE_ROOMS } = await import('../src/modules/waiting-room/waiting-room.js');
const { createSignedInUsers } = await import('../test-support/users.js');
const { deleteEventKeys } = await import('../test-support/redis-cleanup.js');
const { holdWhileCreatingAdmins } = await import('../test-support/admin-lock.js');

await runMigrations({ log: () => {} });
const server = createApp().listen(0);
const baseUrl = `http://localhost:${server.address().port}`;
const RUN = `test-strikes-${ID}`;
let n = 0;
let ip = 0;
const createdEventIds = [];
const releaseAdminsLock = await holdWhileCreatingAdmins();
const [admin] = await createSignedInUsers(1, { prefix: `${RUN}-admin`, role: 'admin' });

after(async () => {
  try {
    for (const id of createdEventIds) {
      const found = [];
      for await (const batch of redis.scanStream({ match: roomKeysPattern(id), count: 1000 })) found.push(...batch);
      if (found.length) await redis.del(...found);
      await redis.srem(ACTIVE_ROOMS, String(id));
    }
    await deleteEventKeys(createdEventIds);
    if (createdEventIds.length) {
      await pool.query('DELETE FROM orders WHERE event_id = ANY($1)', [createdEventIds]);
      await pool.query('DELETE FROM events WHERE id = ANY($1)', [createdEventIds]);
    }
    await pool.query('DELETE FROM users WHERE email LIKE $1', [`${RUN}%`]); // restrictions + requests cascade
    for (const prefix of [`ratelimit-strikes-${ID}`, `bot-test-${ID}`]) {
      const left = await redis.keys(`${prefix}:*`);
      if (left.length) await redis.del(...left);
    }
  } finally {
    await releaseAdminsLock();
    server.close();
    await cloudflare.close();
    await closeConnections();
  }
});

async function event({ room = false } = {}) {
  const e = await createEvent({
    name: `${RUN} event ${++n}`,
    totalTickets: 100,
    saleStartsAt: new Date(Date.now() - 60_000),
    admissionPerSecond: room ? 1 : null,
  });
  createdEventIds.push(e.id);
  return e;
}
const users = (count) => createSignedInUsers(count, { prefix: `${RUN}-${++n}` });
const newIp = () => `198.18.0.${++ip}`; // a test-only IP range

async function api(method, path, { as, body, ipAddress = newIp(), headers = {} } = {}) {
  const h = { 'X-Forwarded-For': ipAddress, ...headers };
  if (as) h.Cookie = as.cookie;
  if (body) h['Content-Type'] = 'application/json';
  const res = await fetch(`${baseUrl}${path}`, { method, headers: h, body: body && JSON.stringify(body) });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}
const hold = (as, e, opts = {}) => api('POST', `/api/events/${e.id}/holds`, { as, body: { quantity: 1 }, ...opts });
const restrictionsOf = async (u) =>
  (await pool.query('SELECT kind, ends_at, evidence, created_by, overturned FROM account_restrictions WHERE user_id = $1 ORDER BY id', [u.id])).rows;

// ---------- normal people never get signals ----------

test('a person clicking normally (even quickly, a few times) gets no signal at all', async () => {
  const e = await event();
  const [ann] = await users(1);
  for (let i = 0; i < 5; i++) await hold(ann, e);
  assert.equal(await redis.exists(keys(ann.id).score), 0);
});

test('a shared IP: 13 people on one IP, the IP limit refuses some of them → nobody gets a signal', async () => {
  const e = await event();
  const crowd = await users(13);
  const shared = newIp();
  const results = await Promise.all(crowd.flatMap((u) => Array.from({ length: 10 }, () => hold(u, e, { ipAddress: shared }))));
  assert.ok(results.some((r) => r.status === 429), 'the per-IP limit did refuse some');
  for (const u of crowd) assert.equal(await redis.exists(keys(u.id).score), 0, 'IP refusals never count against a person');
});

// ---------- a script ----------

test('a script hammering holds: 10 get through, every refusal is a signal, the 20th → SUSPENDED for 15 days', async () => {
  const e = await event();
  const [bot] = await users(1);
  const statuses = [];
  for (let i = 0; i < 31; i++) statuses.push((await hold(bot, e)).status);

  assert.equal(statuses.filter((s) => s === 429).length, 20, '10 allowed, then 20 refusals = 20 points');
  assert.equal(statuses.at(-1), 403, 'the next request is turned away: restricted');

  const [r] = await restrictionsOf(bot);
  assert.equal(r.kind, 'suspended');
  assert.equal(r.created_by, null, 'automatic');
  const days = (new Date(r.ends_at) - Date.now()) / 86_400_000;
  assert.ok(days > 14.9 && days <= 15, `${days} days`);
  assert.deepEqual(r.evidence.signals, { rate_limited: 20 });
  assert.equal(r.evidence.score, 20);
});

test('after a strike: held tickets go back on sale, the queue place is gone, booking is blocked everywhere', async () => {
  const e = await event();
  const room = await event({ room: true });
  const [bot] = await users(1);
  assert.equal((await hold(bot, e)).status, 201);
  assert.equal(Number(await redis.get(stockKey(e.id))), 99);
  assert.equal((await api('POST', `/api/events/${room.id}/queue`, { as: bot, headers: { 'X-Turnstile-Token': cloudflare.newToken() } })).status, 200);

  await strike(bot.id, { reason: 'test' });

  assert.equal(Number(await redis.get(stockKey(e.id))), 100, 'the hold was released');
  assert.equal(await redis.zscore(queueKey(room.id), String(bot.id)), null, 'the queue place is gone');
  for (const [method, path, body] of [
    ['POST', `/api/events/${e.id}/holds`, { quantity: 1 }],
    ['POST', `/api/events/${room.id}/queue`, undefined],
    ['POST', '/api/orders', { holdId: randomUUID() }],
    ['POST', '/api/payments/fake/1', { outcome: 'success' }],
  ]) {
    const res = await api(method, path, { as: bot, body });
    assert.equal(res.status, 403, path);
    assert.equal(res.body.error.code, 'ACCOUNT_RESTRICTED');
    assert.equal(res.body.error.details.kind, 'suspended');
  }
});

test('restricted, but not locked out: /me shows the restriction; reading and the support inbox still work', async () => {
  const e = await event();
  const [bot] = await users(1);
  await strike(bot.id, { reason: 'test' });
  const me = (await api('GET', '/api/auth/me', { as: bot })).body.user;
  assert.equal(me.restriction.kind, 'suspended');
  assert.ok(new Date(me.restriction.until) > new Date());
  assert.equal((await api('GET', `/api/events/${e.id}`, { as: bot })).status, 200);
  assert.equal((await api('GET', '/api/support/requests', { as: bot })).status, 200);
});

test('"are you a person?" failures of a signed-in person: 4 queue joins WITHOUT a token (5 points each) → strike', async () => {
  const room = await event({ room: true });
  const [bot] = await users(1);
  for (let i = 0; i < 4; i++) assert.equal((await api('POST', `/api/events/${room.id}/queue`, { as: bot })).status, 403);
  const [r] = await restrictionsOf(bot);
  assert.deepEqual(r?.evidence.signals, { missing_bot_token: 4 });
});

test('a fake token counts less (2 points: an expired one can happen to a person)', async () => {
  const room = await event({ room: true });
  const [ann] = await users(1);
  await api('POST', `/api/events/${room.id}/queue`, { as: ann, headers: { 'X-Turnstile-Token': 'made-up' } });
  assert.equal(Number(await redis.get(keys(ann.id).score)), 2);
  assert.deepEqual(await restrictionsOf(ann), []);
});

// ---------- the ladder ----------

test('a SECOND strike within a year → BANNED for good', async () => {
  const [bot] = await users(1);
  await pool.query(
    `INSERT INTO account_restrictions (user_id, kind, reason, starts_at, ends_at)
     VALUES ($1, 'suspended', 'earlier', now() - interval '40 days', now() - interval '25 days')`,
    [bot.id],
  ); // served 15 days, over 25 days ago
  const r = await strike(bot.id, { reason: 'again' });
  assert.equal(r.kind, 'banned');
  assert.equal(r.endsAt, null);
  assert.equal((await api('GET', '/api/auth/me', { as: bot })).body.user.restriction.kind, 'banned');
});

test('strikes older than a year, or OVERTURNED (mistakes), don\'t count: → suspended again, not banned', async () => {
  const [a, b] = await users(2);
  await pool.query(
    `INSERT INTO account_restrictions (user_id, kind, reason, starts_at, ends_at) VALUES ($1, 'suspended', 'old', now() - interval '400 days', now() - interval '385 days')`,
    [a.id],
  );
  await pool.query(
    `INSERT INTO account_restrictions (user_id, kind, reason, starts_at, ends_at, lifted_at, overturned)
     VALUES ($1, 'suspended', 'mistake', now() - interval '5 days', now() + interval '10 days', now() - interval '4 days', true)`,
    [b.id],
  );
  assert.equal((await strike(a.id, { reason: 'x' })).kind, 'suspended');
  assert.equal((await strike(b.id, { reason: 'x' })).kind, 'suspended');
});

test('the suspension ENDS by itself when its date passes: booking works again (no job needed)', async () => {
  const e = await event();
  const [bot] = await users(1);
  await strike(bot.id, { reason: 'test' });
  assert.equal((await hold(bot, e)).status, 403);
  await pool.query("UPDATE account_restrictions SET ends_at = now() - interval '1 second' WHERE user_id = $1", [bot.id]);
  assert.equal((await hold(bot, e)).status, 201);
});

test('two strikes at the SAME moment → one restriction, not two', async () => {
  const [bot] = await users(1);
  const results = await Promise.all([strike(bot.id, { reason: 'a' }), strike(bot.id, { reason: 'b' })]);
  assert.equal(results.filter(Boolean).length, 1);
  assert.equal((await restrictionsOf(bot)).length, 1);
});

// ---------- appeals and admins ----------

test('appeal: only while restricted; approved → overturned (booking works, and it won\'t count as a strike)', async () => {
  const e = await event();
  const [ann] = await users(1);
  const appeal = (as) => api('POST', '/api/support/requests', { as, body: { kind: 'appeal', message: 'It was me, clicking fast!' } });
  assert.equal((await appeal(ann)).body.error.code, 'NOT_RESTRICTED');

  await strike(ann.id, { reason: 'test' });
  const request = (await appeal(ann)).body.request;
  assert.equal(request.kind, 'appeal');
  const decided = await api('POST', `/api/admin/support/${request.id}/decision`, { as: admin, body: { decision: 'approved', message: 'Sorry about that.' } });
  assert.equal(decided.status, 200);

  assert.equal((await hold(ann, e)).status, 201, 'booking works again');
  const [r] = await restrictionsOf(ann);
  assert.equal(r.overturned, true);
  assert.equal((await strike(ann.id, { reason: 'later' })).kind, 'suspended', 'the overturned one did not count');
});

test('admins: list restrictions, restrict by email, lift; can\'t restrict themselves; normal users → 403', async () => {
  const [ann, bob] = await users(2);
  const made = await api('POST', '/api/admin/restrictions', { as: admin, body: { email: ann.email, kind: 'banned', reason: 'Ticket reselling ring' } });
  assert.equal(made.status, 201);
  assert.deepEqual([made.body.restriction.kind, made.body.restriction.automatic], ['banned', false]);
  assert.equal((await api('POST', '/api/admin/restrictions', { as: admin, body: { email: ann.email, kind: 'banned', reason: 'again' } })).status, 201, 'an admin may replace it');

  const list = (await api('GET', '/api/admin/restrictions', { as: admin })).body.restrictions;
  assert.ok(list.some((r) => r.userEmail === ann.email && r.kind === 'banned'));

  const lifted = await api('POST', `/api/admin/restrictions/${made.body.restriction.id}/lift`, { as: admin, body: { reason: 'Proved innocent', overturn: true } });
  assert.equal(lifted.status, 200);
  assert.equal((await api('GET', '/api/auth/me', { as: ann })).body.user.restriction, null);

  assert.equal((await api('POST', '/api/admin/restrictions', { as: admin, body: { email: admin.email, kind: 'banned', reason: 'oops' } })).body.error.code, 'CANNOT_RESTRICT_SELF');
  assert.equal((await api('GET', '/api/admin/restrictions', { as: bob })).status, 403);
});

test('logging in tells the page about the restriction straight away (no extra /me call needed)', async () => {
  const { hashPassword } = await import('../src/modules/auth/password.js');
  const email = `${RUN}-login@example.com`;
  const password = 'correct horse battery staple';
  const { rows } = await pool.query('INSERT INTO users (email, password_hash) VALUES ($1, $2) RETURNING id', [email, await hashPassword(password)]);
  await strike(Number(rows[0].id), { reason: 'test' });
  const res = await api('POST', '/api/auth/login', { body: { email, password } });
  assert.equal(res.status, 200, 'restricted people can still sign in');
  assert.equal(res.body.user.restriction.kind, 'suspended');
});
