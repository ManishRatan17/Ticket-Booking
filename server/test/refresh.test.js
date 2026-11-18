// Sessions, refresh-token rotation and reuse detection. Requires `docker compose up -d`.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { decodeJwt } from 'jose';
import { createApp } from '../src/app.js';
import { pool } from '../src/config/db.js';
import { runMigrations } from '../src/db/migrate.js';
import { closeConnections } from '../src/config/connections.js';
import { hashToken } from '../src/modules/auth/tokens.js';

const RUN = `test-refresh-${randomUUID().slice(0, 8)}`;
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

// Pulls "refresh_token=<value>; Path=...; ..." out of the Set-Cookie headers.
function refreshCookie(res) {
  const raw = res.headers.getSetCookie().find((c) => c.startsWith('refresh_token='));
  if (!raw) return null;
  return { raw, value: decodeURIComponent(raw.split(';')[0].slice('refresh_token='.length)) };
}

async function post(path, { body, cookie } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (cookie) headers.Cookie = `refresh_token=${encodeURIComponent(cookie)}`;
  const res = await fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: await res.json(), cookie: refreshCookie(res) };
}

// Registers + logs in a fresh user. Returns its refresh token, access token and session id.
async function loggedInUser() {
  const email = `${RUN}-${++counter}@example.com`;
  await post('/api/auth/register', { body: { email, password: PASSWORD } });
  const login = await post('/api/auth/login', { body: { email, password: PASSWORD } });
  return {
    email,
    refreshToken: login.cookie.value,
    cookieHeader: login.cookie.raw,
    accessToken: login.body.accessToken,
    sessionId: decodeJwt(login.body.accessToken).sid,
  };
}

const refresh = (token) => post('/api/auth/refresh', { cookie: token });

async function sessionRow(sessionId) {
  const { rows } = await pool.query('SELECT * FROM sessions WHERE id = $1', [sessionId]);
  return rows[0];
}

// ---------- login creates a session ----------

test('login: refresh cookie has the right security flags, and is NOT in the JSON body', async () => {
  const user = await loggedInUser();
  const flags = user.cookieHeader.split(';').map((s) => s.trim().toLowerCase());

  assert.ok(flags.includes('httponly'));
  assert.ok(flags.includes('samesite=strict'));
  assert.ok(flags.includes('path=/api/auth'));
  assert.ok(!flags.includes('secure'), 'Secure is for production only');
  assert.ok(flags.some((f) => f.startsWith('expires=')));
  assert.ok(!JSON.stringify(user).includes('"refresh"'), 'refresh token leaked into the body');
});

test('login: database stores only the SHA-256 hash of the refresh token', async () => {
  const user = await loggedInUser();
  const raw = await pool.query('SELECT 1 FROM refresh_tokens WHERE token_hash = $1', [user.refreshToken]);
  const hashed = await pool.query(
    'SELECT session_id, expires_at FROM refresh_tokens WHERE token_hash = $1',
    [hashToken(user.refreshToken)],
  );

  assert.equal(raw.rowCount, 0, 'raw token found in the database');
  assert.equal(hashed.rowCount, 1);
  assert.equal(hashed.rows[0].session_id, user.sessionId);

  const days = (hashed.rows[0].expires_at - Date.now()) / 86_400_000;
  assert.ok(days > 6.9 && days <= 7, `refresh token should live 7 days, got ${days}`);
});

test('login: access token carries the session id (sid) of a real, active session', async () => {
  const user = await loggedInUser();
  const session = await sessionRow(user.sessionId);

  assert.ok(session, 'no session row for sid');
  assert.equal(session.revoked_at, null);
  const days = (session.expires_at - Date.now()) / 86_400_000;
  assert.ok(days > 29.9 && days <= 30, `session should last 30 days, got ${days}`);
});

// ---------- rotation ----------

test('refresh: new access token AND new refresh token; old one marked used and linked', async () => {
  const user = await loggedInUser();
  const res = await refresh(user.refreshToken);

  assert.equal(res.status, 200);
  assert.ok(res.body.accessToken);
  assert.notEqual(res.cookie.value, user.refreshToken, 'refresh token was not rotated');
  assert.equal(decodeJwt(res.body.accessToken).sid, user.sessionId, 'same session continues');

  const { rows } = await pool.query(
    `SELECT old.used_at, old.replaced_by, new.id AS new_id
       FROM refresh_tokens old, refresh_tokens new
      WHERE old.token_hash = $1 AND new.token_hash = $2`,
    [hashToken(user.refreshToken), hashToken(res.cookie.value)],
  );
  assert.notEqual(rows[0].used_at, null);
  assert.equal(rows[0].replaced_by, rows[0].new_id);
});

test('refresh: the new access token works on /me', async () => {
  const user = await loggedInUser();
  const { body } = await refresh(user.refreshToken);
  const me = await fetch(`${baseUrl}/api/auth/me`, { headers: { Authorization: `Bearer ${body.accessToken}` } });
  assert.equal(me.status, 200);
});

test('refresh: a chain R1 → R2 → R3 → R4 works', async () => {
  const user = await loggedInUser();
  let token = user.refreshToken;
  for (let i = 0; i < 3; i++) {
    const res = await refresh(token);
    assert.equal(res.status, 200, `step ${i + 1}`);
    token = res.cookie.value;
  }
});

// ---------- concurrency ----------

test('race: 10 parallel refreshes with one token → exactly 1 succeeds, session survives', async () => {
  const user = await loggedInUser();
  const results = await Promise.all(Array.from({ length: 10 }, () => refresh(user.refreshToken)));
  const statuses = results.map((r) => r.status);

  assert.equal(statuses.filter((s) => s === 200).length, 1, `statuses: ${statuses}`);
  assert.equal(statuses.filter((s) => s === 409).length, 9, `statuses: ${statuses}`);
  assert.equal((await sessionRow(user.sessionId)).revoked_at, null, 'false alarm killed the session');

  // A 409 must NOT clear the cookie: the winner just stored the new token in it.
  for (const r of results.filter((x) => x.status === 409)) {
    assert.equal(r.cookie, null, '409 response touched the cookie');
  }
});

// ---------- reuse detection ----------

test('reuse: an old token presented after the grace window revokes the WHOLE session', async () => {
  const user = await loggedInUser();
  const r2 = (await refresh(user.refreshToken)).cookie.value; // R1 → R2

  // Pretend R1 was used a minute ago (outside the 10-second grace window).
  await pool.query(`UPDATE refresh_tokens SET used_at = now() - interval '1 minute' WHERE token_hash = $1`, [
    hashToken(user.refreshToken),
  ]);

  const attack = await refresh(user.refreshToken); // the "attacker" replays R1
  assert.equal(attack.status, 401);
  assert.equal(attack.body.error.code, 'REFRESH_TOKEN_REUSED');
  assert.ok(attack.cookie.raw.includes('Expires=Thu, 01 Jan 1970'), 'cookie was not cleared');

  const session = await sessionRow(user.sessionId);
  assert.notEqual(session.revoked_at, null);
  assert.equal(session.revoke_reason, 'token_reuse');

  // The legitimate R2 is now dead too: the whole session is gone.
  const legit = await refresh(r2);
  assert.equal(legit.status, 401);
  assert.equal(legit.body.error.code, 'SESSION_REVOKED');
});

test('reuse: other sessions of the same user are NOT affected', async () => {
  const user = await loggedInUser();
  const second = await post('/api/auth/login', { body: { email: user.email, password: PASSWORD } });

  await refresh(user.refreshToken);
  await pool.query(`UPDATE refresh_tokens SET used_at = now() - interval '1 minute' WHERE token_hash = $1`, [
    hashToken(user.refreshToken),
  ]);
  await refresh(user.refreshToken); // triggers revocation of session 1

  assert.equal((await refresh(second.cookie.value)).status, 200, 'session 2 should still work');
});

// ---------- expiry and bad input ----------

test('expired refresh token → 401 REFRESH_TOKEN_EXPIRED', async () => {
  const user = await loggedInUser();
  await pool.query(`UPDATE refresh_tokens SET expires_at = now() - interval '1 second' WHERE token_hash = $1`, [
    hashToken(user.refreshToken),
  ]);
  const res = await refresh(user.refreshToken);
  assert.equal(res.status, 401);
  assert.equal(res.body.error.code, 'REFRESH_TOKEN_EXPIRED');
});

test('session past its 30-day limit → 401 SESSION_EXPIRED', async () => {
  const user = await loggedInUser();
  await pool.query(`UPDATE sessions SET expires_at = now() - interval '1 second' WHERE id = $1`, [user.sessionId]);
  const res = await refresh(user.refreshToken);
  assert.equal(res.status, 401);
  assert.equal(res.body.error.code, 'SESSION_EXPIRED');
});

test('a new refresh token never outlives its session', async () => {
  const user = await loggedInUser();
  await pool.query(`UPDATE sessions SET expires_at = now() + interval '1 hour' WHERE id = $1`, [user.sessionId]);
  const res = await refresh(user.refreshToken);

  const { rows } = await pool.query(
    `SELECT rt.expires_at <= s.expires_at AS capped
       FROM refresh_tokens rt JOIN sessions s ON s.id = rt.session_id
      WHERE rt.token_hash = $1`,
    [hashToken(res.cookie.value)],
  );
  assert.equal(rows[0].capped, true);
});

test('no cookie → 401 REFRESH_TOKEN_MISSING; unknown token → 401 INVALID_REFRESH_TOKEN', async () => {
  const none = await refresh(undefined);
  assert.equal(none.status, 401);
  assert.equal(none.body.error.code, 'REFRESH_TOKEN_MISSING');

  const unknown = await refresh('made-up-token-value');
  assert.equal(unknown.status, 401);
  assert.equal(unknown.body.error.code, 'INVALID_REFRESH_TOKEN');
});
