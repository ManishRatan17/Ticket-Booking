// "Continue with Google", end to end against a FAKE Google. Requires `docker compose up -d`.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { startFakeGoogle } from '../test-support/fake-google.js';
import { readSetCookie, cookieHeader } from '../test-support/cookies.js';

const CLIENT_ID = 'test-client.apps.googleusercontent.com';
const CLIENT_SECRET = 'test-client-secret';
const CLIENT_URL = 'http://client.test';
const PASSWORD = 'correct horse battery staple';

// Start the fake provider, point the app's Google settings at it, THEN load the app.
// (env.js reads process.env when first imported, so the app must be imported afterwards —
// that's why everything below uses `await import()` instead of a normal import.)
const fake = await startFakeGoogle({ clientId: CLIENT_ID, clientSecret: CLIENT_SECRET });
Object.assign(process.env, {
  GOOGLE_CLIENT_ID: CLIENT_ID,
  GOOGLE_CLIENT_SECRET: CLIENT_SECRET,
  GOOGLE_REDIRECT_URI: 'http://localhost:5173/api/auth/google/callback',
  GOOGLE_AUTH_URL: `${fake.url}/auth`,
  GOOGLE_TOKEN_URL: `${fake.url}/token`,
  GOOGLE_JWKS_URL: `${fake.url}/certs`,
  GOOGLE_ISSUER: fake.url,
  CLIENT_URL,
});
const { createApp } = await import('../src/app.js');
const { pool } = await import('../src/config/db.js');
const { runMigrations } = await import('../src/db/migrate.js');
const { closeConnections } = await import('../src/config/connections.js');

await runMigrations({ log: () => {} });
const server = createApp().listen(0);
const baseUrl = `http://localhost:${server.address().port}`;

const RUN = `test-google-${randomUUID().slice(0, 8)}`;
let n = 0;
const newEmail = () => `${RUN}-${++n}@example.com`;
const newSub = () => `${RUN}-sub-${++n}`;

after(async () => {
  await pool.query('DELETE FROM users WHERE email LIKE $1', [`${RUN}-%`]);
  server.close();
  fake.close();
  await closeConnections();
});

// ---------- helpers ----------

const getCookie = readSetCookie;

// Step ①: the browser opens /api/auth/google. redirect: 'manual' lets us inspect the 302.
async function startSignIn() {
  const res = await fetch(`${baseUrl}/api/auth/google`, { redirect: 'manual' });
  return { status: res.status, location: res.headers.get('location'), tx: getCookie(res, 'oauth_tx') };
}

// Google sends the browser back to our callback (with the oauth_tx cookie, if this browser has one).
async function callback(query, txValue) {
  const res = await fetch(`${baseUrl}/api/auth/google/callback?${new URLSearchParams(query)}`, {
    redirect: 'manual',
    headers: txValue ? { Cookie: `oauth_tx=${encodeURIComponent(txValue)}` } : {},
  });
  const location = new URL(res.headers.get('location'));
  return {
    status: res.status,
    location,
    params: Object.fromEntries(location.searchParams),
    refresh: getCookie(res, 'refresh_token'),
    access: getCookie(res, 'access_token'),
  };
}

// The whole round trip. Options are passed to the fake Google (claims, forge, …).
async function signInWithGoogle({ sub = newSub(), email = newEmail(), claims = {}, ...opts } = {}) {
  const start = await startSignIn();
  const { code, state } = fake.authorize(start.location, { claims: { sub, email, ...claims }, ...opts });
  return { ...(await callback({ code, state }, start.tx.value)), sub, email };
}

// Proves a refresh cookie is live: refresh → new access cookie → /me.
async function whoAmI(refreshToken) {
  const r = await fetch(`${baseUrl}/api/auth/refresh`, {
    method: 'POST',
    headers: { Cookie: cookieHeader({ refresh_token: refreshToken }) },
  });
  const accessToken = getCookie(r, 'access_token').value;
  const me = await fetch(`${baseUrl}/api/auth/me`, { headers: { Cookie: cookieHeader({ access_token: accessToken }) } });
  return (await me.json()).user;
}

async function passwordLogin(email) {
  return fetch(`${baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password: PASSWORD }),
  });
}

// ---------- step ①: the redirect to Google ----------

test('start: redirects to Google with every required OpenID Connect + PKCE parameter', async () => {
  const { status, location, tx } = await startSignIn();
  assert.equal(status, 302);
  assert.ok(location.startsWith(`${fake.url}/auth?`));

  const p = new URL(location).searchParams;
  assert.equal(p.get('client_id'), CLIENT_ID);
  assert.equal(p.get('redirect_uri'), 'http://localhost:5173/api/auth/google/callback');
  assert.equal(p.get('response_type'), 'code');
  assert.equal(p.get('scope'), 'openid email profile');
  assert.equal(p.get('code_challenge_method'), 'S256');
  for (const name of ['state', 'nonce', 'code_challenge']) {
    assert.match(p.get(name), /^[A-Za-z0-9_-]{43}$/, `${name} should be 32 random bytes, base64url`);
  }
  assert.ok(!location.includes('client_secret') && !location.includes(CLIENT_SECRET), 'secret in URL!');

  const flags = tx.raw.split(';').map((s) => s.trim().toLowerCase());
  assert.ok(flags.includes('httponly'));
  assert.ok(flags.includes('samesite=lax'), 'must be Lax so it survives the redirect back from Google');
  assert.ok(flags.includes('path=/api/auth/google'));
  assert.ok(flags.includes('max-age=600'));
});

// ---------- happy paths ----------

test('new Google user: account created without a password, signed in via the refresh cookie', async () => {
  const result = await signInWithGoogle();
  assert.equal(result.status, 302);
  assert.equal(result.location.origin, CLIENT_URL);
  assert.deepEqual(result.params, { login: 'google' });
  assert.ok(result.refresh, 'no refresh cookie');
  assert.ok(result.access, 'no access cookie');
  assert.ok(!result.location.href.includes(result.refresh.value), 'token leaked into the redirect URL');
  assert.ok(!result.location.href.includes(result.access.value), 'token leaked into the redirect URL');

  const me = await whoAmI(result.refresh.value);
  assert.equal(me.email, result.email);

  const { rows } = await pool.query(
    `SELECT u.password_hash, u.email_verified_at, i.provider_user_id
       FROM users u JOIN user_identities i ON i.user_id = u.id WHERE u.id = $1`,
    [me.id],
  );
  assert.equal(rows[0].password_hash, null);
  assert.notEqual(rows[0].email_verified_at, null);
  assert.equal(rows[0].provider_user_id, result.sub);
});

test('returning Google user: same account, no duplicate identity', async () => {
  const sub = newSub();
  const email = newEmail();
  const first = await whoAmI((await signInWithGoogle({ sub, email })).refresh.value);
  const second = await whoAmI((await signInWithGoogle({ sub, email })).refresh.value);

  assert.equal(second.id, first.id);
  const { rows } = await pool.query('SELECT count(*)::int AS n FROM user_identities WHERE user_id = $1', [first.id]);
  assert.equal(rows[0].n, 1);
});

test('a Google-only account cannot be logged into with a password', async () => {
  const { email } = await signInWithGoogle();
  const res = await passwordLogin(email);
  assert.equal(res.status, 401);
  assert.equal((await res.json()).error.code, 'INVALID_CREDENTIALS');
});

// ---------- state, single use, login CSRF ----------

test('state mismatch → rejected, no session', async () => {
  const start = await startSignIn();
  const { code } = fake.authorize(start.location, { claims: { sub: newSub(), email: newEmail() } });
  const result = await callback({ code, state: 'not-the-state-we-sent' }, start.tx.value);

  assert.deepEqual(result.params, { login: 'failed', reason: 'OAUTH_STATE_MISMATCH' });
  assert.equal(result.refresh, null);
});

test('replay: the same callback works only once', async () => {
  const start = await startSignIn();
  const query = fake.authorize(start.location, { claims: { sub: newSub(), email: newEmail() } });

  assert.equal((await callback(query, start.tx.value)).params.login, 'google');
  const replay = await callback(query, start.tx.value);
  assert.deepEqual(replay.params, { login: 'failed', reason: 'OAUTH_TX_INVALID' });
});

test('login CSRF: attacker\'s callback link opened in a victim\'s browser is rejected', async () => {
  // Attacker starts a sign-in with THEIR Google account and stops before the callback...
  const attacker = await startSignIn();
  const attackerQuery = fake.authorize(attacker.location, { claims: { sub: newSub(), email: newEmail() } });

  // ...then tricks the victim into opening it. Victim's browser has no oauth_tx cookie:
  const noCookie = await callback(attackerQuery);
  assert.deepEqual(noCookie.params, { login: 'failed', reason: 'OAUTH_TX_INVALID' });

  // ...or has its OWN sign-in in progress (a different cookie, so a different state):
  const victim = await startSignIn();
  const otherCookie = await callback(attackerQuery, victim.tx.value);
  assert.deepEqual(otherCookie.params, { login: 'failed', reason: 'OAUTH_STATE_MISMATCH' });
  assert.equal(otherCookie.refresh, null);
});

test('user clicks Cancel at Google → back to the app, and that attempt is discarded', async () => {
  const start = await startSignIn();
  const query = fake.authorize(start.location, { claims: { sub: newSub(), email: newEmail() } });

  const cancelled = await callback({ error: 'access_denied', state: query.state }, start.tx.value);
  assert.deepEqual(cancelled.params, { login: 'cancelled' });

  const later = await callback(query, start.tx.value); // the attempt can't be resumed
  assert.equal(later.params.reason, 'OAUTH_TX_INVALID');
});

// ---------- PKCE ----------

test('PKCE: a code exchanged without the matching verifier is refused by Google', async () => {
  const result = await signInWithGoogle({ codeChallengeOverride: 'challenge-of-someone-else' });
  assert.deepEqual(result.params, { login: 'failed', reason: 'GOOGLE_EXCHANGE_FAILED' });
});

// ---------- ID token verification ----------

const badTokens = [
  ['wrong nonce (token from another login attempt)', { claims: { nonce: 'some-other-nonce' } }],
  ['wrong audience (token issued to a different app)', { claims: { aud: 'another-app.apps.googleusercontent.com' } }],
  ['wrong issuer', { claims: { iss: 'https://evil.example.com' } }],
  ['expired', { claims: { exp: Math.floor(Date.now() / 1000) - 60 } }],
  ['forged: signed with a key that is not Google\'s', { forge: true }],
];

for (const [name, opts] of badTokens) {
  test(`ID token rejected: ${name}`, async () => {
    const result = await signInWithGoogle(opts);
    assert.deepEqual(result.params, { login: 'failed', reason: 'GOOGLE_TOKEN_INVALID' });
    assert.equal(result.refresh, null);
  });
}

test('Google email not verified → refused, and no user is created', async () => {
  const result = await signInWithGoogle({ claims: { email_verified: false } });
  assert.deepEqual(result.params, { login: 'failed', reason: 'GOOGLE_EMAIL_UNVERIFIED' });
  const { rowCount } = await pool.query('SELECT 1 FROM users WHERE email = $1', [result.email]);
  assert.equal(rowCount, 0);
});

// ---------- account linking ----------

test('linking, "verified email wins": squatter\'s password removed and sessions ended', async () => {
  // A "squatter" registers the victim's email with their own password, and logs in.
  const email = newEmail();
  await fetch(`${baseUrl}/api/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password: PASSWORD }),
  });
  const squatterLogin = await passwordLogin(email);
  const squatterRefresh = getCookie(squatterLogin, 'refresh_token').value;
  const { user: squatterUser } = await squatterLogin.json();

  // The real owner signs in with Google (which PROVES they own the email).
  const owner = await signInWithGoogle({ email });
  assert.equal(owner.params.login, 'google');
  assert.equal((await whoAmI(owner.refresh.value)).id, squatterUser.id, 'should link to the same account');

  // The squatter is locked out: password gone, old session revoked.
  assert.equal((await passwordLogin(email)).status, 401);
  const r = await fetch(`${baseUrl}/api/auth/refresh`, {
    method: 'POST',
    headers: { Cookie: `refresh_token=${encodeURIComponent(squatterRefresh)}` },
  });
  assert.equal((await r.json()).error.code, 'SESSION_REVOKED');

  const { rows } = await pool.query(
    `SELECT u.password_hash, u.email_verified_at,
            (SELECT revoke_reason FROM sessions WHERE user_id = u.id ORDER BY created_at LIMIT 1) AS reason
       FROM users u WHERE u.id = $1`,
    [squatterUser.id],
  );
  assert.equal(rows[0].password_hash, null);
  assert.notEqual(rows[0].email_verified_at, null);
  assert.equal(rows[0].reason, 'account_linked');
});

test('same email but a DIFFERENT Google account than the one linked → 409 conflict', async () => {
  const email = newEmail();
  await signInWithGoogle({ email }); // links Google account #1
  const other = await signInWithGoogle({ email }); // Google account #2, same address
  assert.deepEqual(other.params, { login: 'failed', reason: 'GOOGLE_ACCOUNT_CONFLICT' });
});
