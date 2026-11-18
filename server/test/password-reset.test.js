// Forgot / reset password. Requires `docker compose up -d`.
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createApp } from '../src/app.js';
import { env } from '../src/config/env.js';
import { pool } from '../src/config/db.js';
import { runMigrations } from '../src/db/migrate.js';
import { closeConnections } from '../src/config/connections.js';
import { setMailTransport } from '../src/lib/mailer.js';
import { hashToken } from '../src/modules/auth/tokens.js';
import { readSetCookie, cookieHeader } from '../test-support/cookies.js';

const RUN = `test-reset-${randomUUID().slice(0, 8)}`;
let counter = 0;
const newEmail = () => `${RUN}-${++counter}@example.com`;
const OLD_PASSWORD = 'correct horse battery staple';
const NEW_PASSWORD = 'a brand new long passphrase';

let server, baseUrl;
let inbox = []; // every "sent" email lands here instead of the console

before(async () => {
  await runMigrations({ log: () => {} });
  server = createApp().listen(0);
  baseUrl = `http://localhost:${server.address().port}`;
  setMailTransport(async (mail) => inbox.push(mail));
});

beforeEach(() => {
  inbox = [];
});

after(async () => {
  setMailTransport(null);
  await pool.query('DELETE FROM users WHERE email LIKE $1', [`${RUN}-%`]);
  server.close();
  await closeConnections();
});

// ---------- helpers ----------

function post(path, body, cookies = {}) {
  const headers = { 'Content-Type': 'application/json' };
  const cookie = cookieHeader(cookies);
  if (cookie) headers.Cookie = cookie;
  return fetch(`${baseUrl}${path}`, { method: 'POST', headers, body: JSON.stringify(body) });
}

async function registeredUser() {
  const email = newEmail();
  await post('/api/auth/register', { email, password: OLD_PASSWORD });
  return email;
}

const login = (email, password) => post('/api/auth/login', { email, password });

// The email is sent in the background, so wait (briefly) for it to arrive.
async function waitForMail(to, { timeoutMs = 3000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const mail = inbox.find((m) => m.to === to);
    if (mail) return mail;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return null;
}

// What the user does: click the link. Returns the token from its #fragment.
function tokenFromMail(mail) {
  const link = mail.text.match(/https?:\/\/\S+/)[0];
  return new URL(link).hash.slice('#token='.length);
}

async function requestToken(email) {
  await post('/api/auth/forgot-password', { email });
  return tokenFromMail(await waitForMail(email));
}

const reset = (token, password = NEW_PASSWORD) => post('/api/auth/reset-password', { token, password });

// ---------- forgot password ----------

test('forgot: an email with a one-time link; the token is in the #fragment, never ?query', async () => {
  const email = await registeredUser();
  const res = await post('/api/auth/forgot-password', { email: email.toUpperCase() });
  assert.equal(res.status, 200);

  const mail = await waitForMail(email);
  assert.ok(mail, 'no email was sent');
  const link = new URL(mail.text.match(/https?:\/\/\S+/)[0]);
  assert.equal(`${link.origin}${link.pathname}`, `${env.clientUrl}/reset-password`);
  assert.equal(link.search, '', 'token must not be in the query string');
  assert.match(link.hash, /^#token=[A-Za-z0-9_-]{43}$/);

  // Only the hash is stored.
  const token = tokenFromMail(mail);
  const { rows } = await pool.query(
    `SELECT (SELECT count(*) FROM password_reset_tokens WHERE token_hash = $1)::int AS raw,
            (SELECT count(*) FROM password_reset_tokens WHERE token_hash = $2)::int AS hashed`,
    [token, hashToken(token)],
  );
  assert.deepEqual(rows[0], { raw: 0, hashed: 1 });
});

test('forgot: unknown email → the IDENTICAL response, and no email is sent', async () => {
  const known = await post('/api/auth/forgot-password', { email: await registeredUser() });
  const unknownEmail = newEmail();
  const unknown = await post('/api/auth/forgot-password', { email: unknownEmail });

  assert.equal(unknown.status, known.status);
  assert.deepEqual(await unknown.json(), await known.json());
  assert.equal(await waitForMail(unknownEmail, { timeoutMs: 300 }), null);
});

test('forgot: the response never waits for the email (no timing leak)', async () => {
  const email = await registeredUser();
  // A mail provider that takes 1.5 seconds…
  setMailTransport(async (mail) => {
    await new Promise((resolve) => setTimeout(resolve, 1500));
    inbox.push(mail);
  });
  try {
    const start = performance.now();
    await post('/api/auth/forgot-password', { email });
    const ms = performance.now() - start;
    assert.ok(ms < 500, `response took ${ms.toFixed(0)} ms: it waited for the mail provider`);
    assert.ok(await waitForMail(email), 'the email should still arrive later');
  } finally {
    setMailTransport(async (mail) => inbox.push(mail));
  }
});

test('forgot: asking again cancels the previous link (only the newest works)', async () => {
  const email = await registeredUser();
  const first = await requestToken(email);
  inbox = [];
  const second = await requestToken(email);

  assert.equal((await reset(first)).status, 400);
  assert.equal((await reset(second)).status, 204);
});

// ---------- reset password ----------

test('reset: new password works, old one doesn\'t, and EVERY old session is ended', async () => {
  const email = await registeredUser();
  const oldLogin = await login(email, OLD_PASSWORD);
  const oldAccess = readSetCookie(oldLogin, 'access_token').value;

  const res = await reset(await requestToken(email));
  assert.equal(res.status, 204);

  assert.equal((await login(email, OLD_PASSWORD)).status, 401);
  assert.equal((await login(email, NEW_PASSWORD)).status, 200);

  const me = await fetch(`${baseUrl}/api/auth/me`, { headers: { Cookie: cookieHeader({ access_token: oldAccess }) } });
  assert.equal(me.status, 401);
  assert.equal((await me.json()).error.code, 'SESSION_REVOKED');

  const { rows } = await pool.query(
    `SELECT u.email_verified_at, s.revoke_reason
       FROM users u JOIN sessions s ON s.user_id = u.id
      WHERE u.email = $1 ORDER BY s.created_at LIMIT 1`,
    [email],
  );
  assert.notEqual(rows[0].email_verified_at, null, 'using the emailed link proves email ownership');
  assert.equal(rows[0].revoke_reason, 'password_reset');
});

test('reset: a link works only once', async () => {
  const token = await requestToken(await registeredUser());
  assert.equal((await reset(token)).status, 204);
  const again = await reset(token, 'yet another long passphrase');
  assert.equal(again.status, 400);
  assert.equal((await again.json()).error.code, 'RESET_TOKEN_INVALID');
});

test('reset: race — 5 parallel resets with one link → exactly one succeeds', async () => {
  const token = await requestToken(await registeredUser());
  const statuses = (await Promise.all(Array.from({ length: 5 }, () => reset(token)))).map((r) => r.status);
  assert.equal(statuses.filter((s) => s === 204).length, 1, `statuses: ${statuses}`);
});

test('reset: an expired link (older than 15 minutes) is refused', async () => {
  const token = await requestToken(await registeredUser());
  await pool.query(`UPDATE password_reset_tokens SET expires_at = now() - interval '1 second' WHERE token_hash = $1`, [
    hashToken(token),
  ]);
  assert.equal((await reset(token)).status, 400);
});

test('reset: a made-up or malformed token → 400', async () => {
  assert.equal((await reset('A'.repeat(43))).status, 400);
  assert.equal((await reset('short')).status, 400);
});

test('reset: weak password → 400, and the link STILL works afterwards', async () => {
  const token = await requestToken(await registeredUser());
  const weak = await reset(token, 'qwertyuiop'); // common password
  assert.equal(weak.status, 400);
  assert.equal((await weak.json()).error.code, 'VALIDATION_ERROR');
  assert.equal((await reset(token)).status, 204);
});

test('reset: password = email → 400, and the claim is ROLLED BACK so the link still works', async () => {
  const email = await registeredUser();
  const token = await requestToken(email);

  const res = await reset(token, email.toUpperCase());
  assert.equal(res.status, 400);
  assert.equal((await res.json()).error.details[0].field, 'body.password');

  assert.equal((await reset(token)).status, 204, 'the failed attempt must not have used up the link');
});

test('reset: a Google-only account (no password) can ADD a password this way', async () => {
  const email = newEmail();
  await pool.query('INSERT INTO users (email, password_hash, email_verified_at) VALUES ($1, NULL, now())', [email]);
  assert.equal((await login(email, NEW_PASSWORD)).status, 401);

  assert.equal((await reset(await requestToken(email))).status, 204);
  assert.equal((await login(email, NEW_PASSWORD)).status, 200);
});
