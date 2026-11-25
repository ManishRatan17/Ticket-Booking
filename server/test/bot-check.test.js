// Phase 5d: the "are you a person?" check (Cloudflare Turnstile) and the register honeypot.
// Runs against a FAKE Cloudflare (test-support/fake-turnstile.js). Requires Docker.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { startFakeTurnstile } from '../test-support/fake-turnstile.js';

// .env.test switches the check OFF for the rest of the suite. This file switches it on, pointed
// at the fake. Set BEFORE the app is imported: env.js reads process.env once.
const SECRET = 'test-turnstile-secret';
const cloudflare = await startFakeTurnstile({ secret: SECRET });
Object.assign(process.env, {
  TURNSTILE_SITE_KEY: 'test-site-key',
  TURNSTILE_SECRET_KEY: SECRET,
  TURNSTILE_VERIFY_URL: cloudflare.url,
  TRUST_PROXY: 'loopback', // so a test can say which IP the visitor has
});

const { createApp } = await import('../src/app.js');
const { pool } = await import('../src/config/db.js');
const { redis } = await import('../src/config/redis.js');
const { runMigrations } = await import('../src/db/migrate.js');
const { closeConnections } = await import('../src/config/connections.js');
const { createEvent } = await import('../src/modules/events/events.service.js');
const { ACTIVE_ROOMS, roomKeysPattern } = await import('../src/modules/waiting-room/waiting-room.js');
const { createSignedInUsers } = await import('../test-support/users.js');
const { deleteEventKeys } = await import('../test-support/redis-cleanup.js');

await runMigrations({ log: () => {} });
const server = createApp().listen(0);
const baseUrl = `http://localhost:${server.address().port}`;

const RUN = `test-botcheck-${randomUUID().slice(0, 8)}`;
const PASSWORD = 'correct horse battery staple';
let n = 0;
const createdEventIds = [];

after(async () => {
  for (const id of createdEventIds) {
    const keys = [];
    for await (const batch of redis.scanStream({ match: roomKeysPattern(id), count: 1000 })) keys.push(...batch);
    if (keys.length) await redis.del(...keys);
    await redis.srem(ACTIVE_ROOMS, String(id));
  }
  await deleteEventKeys(createdEventIds);
  if (createdEventIds.length) await pool.query('DELETE FROM events WHERE id = ANY($1)', [createdEventIds]);
  await pool.query('DELETE FROM users WHERE email LIKE $1', [`${RUN}%`]);
  server.close();
  await cloudflare.close();
  await closeConnections();
});

const email = () => `${RUN}-${++n}@example.com`;

function register(body, { token, ip = '203.0.113.7' } = {}) {
  const headers = { 'Content-Type': 'application/json', 'X-Forwarded-For': ip };
  if (token) headers['X-Turnstile-Token'] = token;
  return fetch(`${baseUrl}/api/auth/register`, { method: 'POST', headers, body: JSON.stringify(body) }).then(async (res) => ({
    status: res.status,
    body: await res.json(),
  }));
}
const userExists = async (address) => (await pool.query('SELECT 1 FROM users WHERE email = $1', [address])).rowCount === 1;

// ---------- the page learns the site key from the server ----------

test('GET /api/config gives the page the PUBLIC site key (never the secret)', async () => {
  const res = await fetch(`${baseUrl}/api/config`);
  const body = await res.json();
  assert.deepEqual(body.botCheck, { siteKey: 'test-site-key' });
  assert.deepEqual(body.payments, { provider: 'fake' }, 'no Razorpay keys here: the fake provider');
  assert.ok(!JSON.stringify(body).includes(SECRET));
});

// ---------- register ----------

test('register without a token → 403 BOT_CHECK_FAILED, no account', async () => {
  const address = email();
  const res = await register({ email: address, password: PASSWORD });
  assert.equal(res.status, 403);
  assert.equal(res.body.error.code, 'BOT_CHECK_FAILED');
  assert.equal(await userExists(address), false);
});

test('register with a good token → 201; Cloudflare was asked with our secret, the token and the visitor IP', async () => {
  const token = cloudflare.newToken();
  const res = await register({ email: email(), password: PASSWORD }, { token, ip: '203.0.113.42' });
  assert.equal(res.status, 201);
  assert.deepEqual(cloudflare.calls.at(-1), { secret: SECRET, response: token, remoteip: '203.0.113.42' });
});

test('a token works ONCE: replaying it → 403', async () => {
  const token = cloudflare.newToken();
  assert.equal((await register({ email: email(), password: PASSWORD }, { token })).status, 201);
  const replay = await register({ email: email(), password: PASSWORD }, { token });
  assert.equal(replay.status, 403);
});

test('a made-up token → 403', async () => {
  assert.equal((await register({ email: email(), password: PASSWORD }, { token: 'i-am-totally-human' })).status, 403);
});

test('a form with a typo → 400, and the token is NOT used up (no call to Cloudflare)', async () => {
  const before = cloudflare.calls.length;
  const token = cloudflare.newToken();
  const bad = await register({ email: 'not-an-email', password: PASSWORD }, { token });
  assert.equal(bad.status, 400);
  assert.equal(cloudflare.calls.length, before, 'validation runs first');
  assert.equal((await register({ email: email(), password: PASSWORD }, { token })).status, 201, 'same token, fixed form');
});

test('honeypot: the hidden "website" field filled in → 403 even with a good token, no account', async () => {
  const address = email();
  const res = await register({ email: address, password: PASSWORD, website: 'http://spam.example' }, { token: cloudflare.newToken() });
  assert.equal(res.status, 403);
  assert.equal(res.body.error.code, 'BOT_CHECK_FAILED');
  assert.equal(await userExists(address), false);
});

// ---------- Cloudflare unavailable: fail open ----------

test('Cloudflare answers 500, or drops the connection → requests are ALLOWED (fail open)', async (t) => {
  t.after(() => cloudflare.setMode('ok'));
  cloudflare.setMode('error');
  assert.equal((await register({ email: email(), password: PASSWORD }, { token: cloudflare.newToken() })).status, 201);
  cloudflare.setMode('hangup');
  assert.equal((await register({ email: email(), password: PASSWORD }, { token: cloudflare.newToken() })).status, 201);
});

test('…but a wrong SECRET (our mistake) is not "unavailable": refused, and logged', async (t) => {
  const { botCheck } = (await import('../src/config/env.js')).env;
  const real = botCheck.secretKey;
  t.after(() => (botCheck.secretKey = real));
  botCheck.secretKey = 'wrong-secret';
  assert.equal((await register({ email: email(), password: PASSWORD }, { token: cloudflare.newToken() })).status, 403);
});

// ---------- joining a queue ----------

test('joining a waiting room needs a token too; holds and other endpoints do not', async () => {
  const e = await createEvent({
    name: `${RUN} event`,
    totalTickets: 10,
    saleStartsAt: new Date(Date.now() - 60_000),
    admissionPerSecond: 1,
  });
  createdEventIds.push(e.id);
  const [ann] = await createSignedInUsers(1, { prefix: `${RUN}-u` });
  const join = (token) =>
    fetch(`${baseUrl}/api/events/${e.id}/queue`, {
      method: 'POST',
      headers: { Cookie: ann.cookie, ...(token ? { 'X-Turnstile-Token': token } : {}) },
    });

  const without = await join();
  assert.equal(without.status, 403);
  assert.equal((await without.json()).error.code, 'BOT_CHECK_FAILED');
  assert.equal((await (await join(cloudflare.newToken())).json()).status, 'waiting');

  const status = await fetch(`${baseUrl}/api/events/${e.id}/queue`, { headers: { Cookie: ann.cookie } });
  assert.equal(status.status, 200, 'reading your status needs no token');
});

test('not signed in → 401 BEFORE the bot check (no Cloudflare call wasted)', async () => {
  const before = cloudflare.calls.length;
  const res = await fetch(`${baseUrl}/api/events/1/queue`, { method: 'POST', headers: { 'X-Turnstile-Token': cloudflare.newToken() } });
  assert.equal(res.status, 401);
  assert.equal(cloudflare.calls.length, before);
});
