// CSRF guard: cookies are sent automatically, so the server must check WHO started a request.
// Requires `docker compose up -d`.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createApp } from '../src/app.js';
import { env } from '../src/config/env.js';
import { pool } from '../src/config/db.js';
import { runMigrations } from '../src/db/migrate.js';
import { closeConnections } from '../src/config/connections.js';
import { readSetCookie, cookieHeader } from '../test-support/cookies.js';

const RUN = `test-csrf-${randomUUID().slice(0, 8)}`;
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

// A harmless state-changing request (logout without a session always answers 204).
const logout = (headers) => fetch(`${baseUrl}/api/auth/logout`, { method: 'POST', headers });

const blocked = [
  ['Sec-Fetch-Site: cross-site (another website)', { 'Sec-Fetch-Site': 'cross-site' }],
  ['Sec-Fetch-Site: same-site (another subdomain)', { 'Sec-Fetch-Site': 'same-site' }],
  ['Origin of another website (older browser)', { Origin: 'https://evil.example' }],
  ['Origin: null (sandboxed iframe)', { Origin: 'null' }],
];

for (const [name, headers] of blocked) {
  test(`POST blocked: ${name} → 403 CSRF_REJECTED`, async () => {
    const res = await logout(headers);
    assert.equal(res.status, 403);
    assert.equal((await res.json()).error.code, 'CSRF_REJECTED');
  });
}

const allowed = [
  ['Sec-Fetch-Site: same-origin (our own page)', { 'Sec-Fetch-Site': 'same-origin' }],
  ['Sec-Fetch-Site: none (typed by the user)', { 'Sec-Fetch-Site': 'none' }],
  ['Origin of our React app (CLIENT_URL)', { Origin: new URL(env.clientUrl).origin }],
  ['no browser headers at all (curl, Postman, server-to-server)', {}],
];

for (const [name, headers] of allowed) {
  test(`POST allowed: ${name}`, async () => {
    assert.equal((await logout(headers)).status, 204);
  });
}

test('GET is never blocked, even cross-site (GET must not change anything)', async () => {
  const res = await fetch(`${baseUrl}/api/health`, { headers: { 'Sec-Fetch-Site': 'cross-site' } });
  assert.equal(res.status, 200);
});

test('the real attack: evil site triggers "log out everywhere" with the victim\'s cookies', async () => {
  const email = `${RUN}-victim@example.com`;
  await fetch(`${baseUrl}/api/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password: PASSWORD }),
  });
  const login = await fetch(`${baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password: PASSWORD }),
  });
  const victimCookies = cookieHeader({ access_token: readSetCookie(login, 'access_token').value });

  // The victim's browser sends their cookies — but also says the request came from evil.com.
  const attack = await fetch(`${baseUrl}/api/auth/logout-all`, {
    method: 'POST',
    headers: { Cookie: victimCookies, 'Sec-Fetch-Site': 'cross-site', Origin: 'https://evil.example' },
  });
  assert.equal(attack.status, 403);

  // The victim is still logged in.
  const me = await fetch(`${baseUrl}/api/auth/me`, { headers: { Cookie: victimCookies } });
  assert.equal(me.status, 200);
});
