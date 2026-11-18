// Logout, logout-all, the session list and INSTANT revocation of access tokens.
// Requires `docker compose up -d`.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { decodeJwt } from 'jose';
import { createApp } from '../src/app.js';
import { pool } from '../src/config/db.js';
import { redis } from '../src/config/redis.js';
import { runMigrations } from '../src/db/migrate.js';
import { closeConnections } from '../src/config/connections.js';
import { hashToken } from '../src/modules/auth/tokens.js';
import { rebuildRevokedSessions } from '../src/modules/auth/revocation.js';
import { readSetCookie, cookieHeader } from '../test-support/cookies.js';

const RUN = `test-sessions-${randomUUID().slice(0, 8)}`;
let counter = 0;
const PASSWORD = 'correct horse battery staple';

let server, baseUrl;

before(async () => {
  await runMigrations({ log: () => {} });
  server = createApp().listen(0);
  baseUrl = `http://localhost:${server.address().port}`;
});

after(async () => {
  await pool.query('DELETE FROM users WHERE email LIKE $1', [`${RUN}-%`]);
  server.close();
  await closeConnections();
});

// ---------- helpers ----------

// `token` = access token, `cookie` = refresh token; both sent as cookies, like a browser.
async function api(method, path, { token, cookie, body } = {}) {
  const headers = {};
  const cookies = cookieHeader({ access_token: token, refresh_token: cookie });
  if (cookies) headers.Cookie = cookies;
  if (body) headers['Content-Type'] = 'application/json';
  const res = await fetch(`${baseUrl}${path}`, { method, headers, body: body && JSON.stringify(body) });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null, setCookie: res.headers.getSetCookie() };
}

async function newUser() {
  const email = `${RUN}-${++counter}@example.com`;
  await api('POST', '/api/auth/register', { body: { email, password: PASSWORD } });
  return email;
}

// One login = one session ("one device").
async function login(email, userAgent = 'test-device') {
  const res = await fetch(`${baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'User-Agent': userAgent },
    body: JSON.stringify({ email, password: PASSWORD }),
  });
  const accessToken = readSetCookie(res, 'access_token').value;
  const refreshToken = readSetCookie(res, 'refresh_token').value;
  return { accessToken, refreshToken, sessionId: decodeJwt(accessToken).sid };
}

const me = (accessToken) => api('GET', '/api/auth/me', { token: accessToken });

// ---------- logout ----------

test('logout: access token rejected IMMEDIATELY, refresh token dead, cookie cleared', async () => {
  const device = await login(await newUser());
  assert.equal((await me(device.accessToken)).status, 200);

  const out = await api('POST', '/api/auth/logout', { cookie: device.refreshToken });
  assert.equal(out.status, 204);
  assert.ok(out.setCookie.some((c) => c.startsWith('refresh_token=;')), 'refresh cookie not cleared');
  assert.ok(out.setCookie.some((c) => c.startsWith('access_token=;')), 'access cookie not cleared');

  // The JWT itself is still perfectly valid (signature, expiry) — but the session is over.
  const after = await me(device.accessToken);
  assert.equal(after.status, 401);
  assert.equal(after.body.error.code, 'SESSION_REVOKED');

  const refresh = await api('POST', '/api/auth/refresh', { cookie: device.refreshToken });
  assert.equal(refresh.body.error.code, 'SESSION_REVOKED');
});

test('logout is idempotent: no cookie, unknown cookie and logging out twice all give 204', async () => {
  const device = await login(await newUser());
  assert.equal((await api('POST', '/api/auth/logout')).status, 204);
  assert.equal((await api('POST', '/api/auth/logout', { cookie: 'made-up' })).status, 204);
  assert.equal((await api('POST', '/api/auth/logout', { cookie: device.refreshToken })).status, 204);
  assert.equal((await api('POST', '/api/auth/logout', { cookie: device.refreshToken })).status, 204);

  const { rows } = await pool.query('SELECT revoke_reason FROM sessions WHERE id = $1', [device.sessionId]);
  assert.equal(rows[0].revoke_reason, 'logout');
});

test('the Redis revocation key expires with the access token (≤ 15 minutes)', async () => {
  const device = await login(await newUser());
  await api('POST', '/api/auth/logout', { cookie: device.refreshToken });
  const ttl = await redis.ttl(`session:revoked:${device.sessionId}`);
  assert.ok(ttl > 890 && ttl <= 900, `TTL was ${ttl}`);
});

// ---------- logout-all ----------

test('logout-all: every device is logged out at once', async () => {
  const email = await newUser();
  const laptop = await login(email, 'laptop');
  const phone = await login(email, 'phone');

  assert.equal((await api('POST', '/api/auth/logout-all', { token: laptop.accessToken })).status, 204);

  for (const device of [laptop, phone]) {
    assert.equal((await me(device.accessToken)).status, 401);
    assert.equal((await api('POST', '/api/auth/refresh', { cookie: device.refreshToken })).status, 401);
  }
});

test('logout-all needs an access token', async () => {
  assert.equal((await api('POST', '/api/auth/logout-all')).status, 401);
});

// ---------- the session list ----------

test('sessions list: active sessions only, newest first, the current one marked', async () => {
  const email = await newUser();
  const laptop = await login(email, 'Firefox on Windows');
  const phone = await login(email, 'Chrome on Android');
  const old = await login(email, 'Old tablet');
  await api('POST', '/api/auth/logout', { cookie: old.refreshToken });

  const { status, body } = await api('GET', '/api/auth/sessions', { token: phone.accessToken });
  assert.equal(status, 200);
  assert.deepEqual(body.sessions.map((s) => s.userAgent), ['Chrome on Android', 'Firefox on Windows']);
  assert.deepEqual(body.sessions.map((s) => s.current), [true, false]);
  assert.equal(body.sessions[1].id, laptop.sessionId);
});

test('delete one of MY sessions: that device is logged out, mine keeps working', async () => {
  const email = await newUser();
  const laptop = await login(email);
  const phone = await login(email);

  const del = await api('DELETE', `/api/auth/sessions/${phone.sessionId}`, { token: laptop.accessToken });
  assert.equal(del.status, 204);
  assert.equal((await me(phone.accessToken)).status, 401);
  assert.equal((await me(laptop.accessToken)).status, 200);
});

test('IDOR: deleting SOMEONE ELSE\'S session → 404, and their session is untouched', async () => {
  const attacker = await login(await newUser());
  const victim = await login(await newUser());

  const res = await api('DELETE', `/api/auth/sessions/${victim.sessionId}`, { token: attacker.accessToken });
  assert.equal(res.status, 404); // not 403: don't even confirm the session exists
  assert.equal(res.body.error.code, 'SESSION_NOT_FOUND');
  assert.equal((await me(victim.accessToken)).status, 200, 'victim was logged out!');
});

test('delete with an id that is not a UUID → 400 before any SQL runs', async () => {
  const device = await login(await newUser());
  const res = await api('DELETE', "/api/auth/sessions/1' OR '1'='1", { token: device.accessToken });
  assert.equal(res.status, 400);
  assert.equal(res.body.error.code, 'VALIDATION_ERROR');
});

// ---------- closing the gap left open in A4 ----------

test('after refresh-token reuse is detected, the attacker\'s access token dies immediately', async () => {
  const device = await login(await newUser());
  await api('POST', '/api/auth/refresh', { cookie: device.refreshToken }); // R1 → R2
  await pool.query(`UPDATE refresh_tokens SET used_at = now() - interval '1 minute' WHERE token_hash = $1`, [
    hashToken(device.refreshToken),
  ]);
  const reuse = await api('POST', '/api/auth/refresh', { cookie: device.refreshToken });
  assert.equal(reuse.body.error.code, 'REFRESH_TOKEN_REUSED');

  const res = await me(device.accessToken); // issued before the theft was detected
  assert.equal(res.status, 401);
  assert.equal(res.body.error.code, 'SESSION_REVOKED');
});

// ---------- Redis loses its data ----------

test('Redis lost the revocation keys → rebuilt from Postgres (the source of truth)', async () => {
  const device = await login(await newUser());
  await api('POST', '/api/auth/logout', { cookie: device.refreshToken });

  // Simulate Redis restarting empty: the key is gone, so the old token works again. ❌
  await redis.del(`session:revoked:${device.sessionId}`);
  assert.equal((await me(device.accessToken)).status, 200, 'expected the gap to reappear');

  // What the server does on startup and on every Redis reconnect:
  const restored = await rebuildRevokedSessions();
  assert.ok(restored >= 1);
  assert.equal((await me(device.accessToken)).status, 401); // ✅ blocked again
});
