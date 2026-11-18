// Login, access tokens and the authenticate middleware. Requires `docker compose up -d`.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { SignJWT, decodeJwt, decodeProtectedHeader } from 'jose';
import argon2 from 'argon2';
import { createApp } from '../src/app.js';
import { env } from '../src/config/env.js';
import { pool } from '../src/config/db.js';
import { runMigrations } from '../src/db/migrate.js';
import { closeConnections } from '../src/config/connections.js';
import { readSetCookie, cookieHeader, cookieFlags } from '../test-support/cookies.js';

const RUN = `test-login-${randomUUID().slice(0, 8)}`;
let counter = 0;
const newEmail = () => `${RUN}-${++counter}@example.com`;
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

// `token` is sent the way a browser would: as the access_token cookie.
async function call(method, path, { body, token } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Cookie = cookieHeader({ access_token: token });
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  const accessCookie = readSetCookie(res, 'access_token');
  return {
    status: res.status,
    headers: res.headers,
    body: await res.json(),
    accessCookie,
    accessToken: accessCookie?.value,
  };
}

async function registeredUser() {
  const email = newEmail();
  const { body } = await call('POST', '/api/auth/register', { body: { email, password: PASSWORD } });
  return { email, id: body.user.id };
}

const secretKey = new TextEncoder().encode(env.jwt.accessSecret);
const b64url = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64url');

// Signs a token with our real secret but custom claims — for crafting test tokens.
function craftToken(claims, { key = secretKey, exp } = {}) {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({ role: 'user', ...claims })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(claims.sub ?? '1')
    .setIssuer(claims.iss ?? env.jwt.issuer)
    .setAudience(claims.aud ?? env.jwt.audience)
    .setIssuedAt(now)
    .setExpirationTime(exp ?? now + 60)
    .sign(key);
}

// ---------- login ----------

test('login: 200 with a correctly built HS256 access token', async () => {
  const { email, id } = await registeredUser();
  const { status, body, accessToken } = await call('POST', '/api/auth/login', {
    body: { email: email.toUpperCase(), password: PASSWORD },
  });

  assert.equal(status, 200);
  assert.equal(body.expiresIn, 900);
  assert.deepEqual(Object.keys(body.user).sort(), ['createdAt', 'email', 'id', 'role']);

  // A JWT's header and payload are readable by ANYONE, no secret needed:
  const header = decodeProtectedHeader(accessToken);
  const payload = decodeJwt(accessToken);
  assert.equal(header.alg, 'HS256');
  assert.equal(payload.sub, String(id));
  assert.equal(payload.role, 'user');
  assert.equal(payload.iss, 'flash-sale-api');
  assert.equal(payload.aud, 'flash-sale-web');
  assert.equal(payload.exp - payload.iat, 900);
  assert.ok(!JSON.stringify(payload).includes('argon2'), 'hash leaked into token');
});

test('login: the access token is ONLY in an httpOnly, Secure, SameSite=Strict cookie', async () => {
  const { email } = await registeredUser();
  const { body, accessCookie } = await call('POST', '/api/auth/login', { body: { email, password: PASSWORD } });

  // Nothing token-shaped in the JSON: JavaScript (and so XSS) never sees it.
  assert.deepEqual(Object.keys(body).sort(), ['expiresIn', 'user']);
  assert.ok(!JSON.stringify(body).includes(accessCookie.value));

  const flags = cookieFlags(accessCookie.raw);
  assert.ok(flags.includes('httponly'));
  assert.ok(flags.includes('secure'));
  assert.ok(flags.includes('samesite=strict'));
  assert.ok(flags.includes('path=/api'));
  assert.ok(flags.includes('max-age=900'), 'cookie should live exactly as long as the JWT');
});

test('login: wrong password and unknown email give IDENTICAL 401 responses', async () => {
  const { email } = await registeredUser();
  const wrong = await call('POST', '/api/auth/login', { body: { email, password: 'not the password' } });
  const unknown = await call('POST', '/api/auth/login', {
    body: { email: newEmail(), password: PASSWORD },
  });

  assert.equal(wrong.status, 401);
  assert.equal(unknown.status, 401);
  assert.deepEqual(wrong.body, unknown.body);
  assert.equal(wrong.body.error.code, 'INVALID_CREDENTIALS');
});

test('login timing: unknown email takes about as long as a wrong password', async (t) => {
  const { email } = await registeredUser();
  const median = (xs) => xs.sort((a, b) => a - b)[Math.floor(xs.length / 2)];
  async function time(body) {
    const start = performance.now();
    await call('POST', '/api/auth/login', { body });
    return performance.now() - start;
  }

  await time({ email: newEmail(), password: PASSWORD }); // warm-up: creates the dummy hash
  const wrongTimes = [];
  const unknownTimes = [];
  for (let i = 0; i < 7; i++) {
    wrongTimes.push(await time({ email, password: 'not the password' }));
    unknownTimes.push(await time({ email: newEmail(), password: PASSWORD }));
  }
  const wrong = median(wrongTimes);
  const unknown = median(unknownTimes);
  t.diagnostic(`median wrong password: ${wrong.toFixed(0)} ms, unknown email: ${unknown.toFixed(0)} ms`);

  // Without the dummy hash, "unknown" would be ~1-3 ms vs ~50+ ms: a huge, measurable gap.
  assert.ok(unknown > wrong * 0.5, 'unknown-email logins are suspiciously fast');
});

test('login: an old weak hash is upgraded to current settings', async () => {
  const email = newEmail();
  const weakHash = await argon2.hash(PASSWORD, { type: argon2.argon2id, memoryCost: 4096, timeCost: 1 });
  await pool.query('INSERT INTO users (email, password_hash) VALUES ($1, $2)', [email, weakHash]);

  const { status } = await call('POST', '/api/auth/login', { body: { email, password: PASSWORD } });
  assert.equal(status, 200);

  const { rows } = await pool.query('SELECT password_hash FROM users WHERE email = $1', [email]);
  assert.match(rows[0].password_hash, /^\$argon2id\$v=19\$m=19456,t=2,p=1\$/);
  assert.ok(await argon2.verify(rows[0].password_hash, PASSWORD), 'upgraded hash does not verify');
});

test('login: missing password → 400', async () => {
  const { status, body } = await call('POST', '/api/auth/login', { body: { email: newEmail() } });
  assert.equal(status, 400);
  assert.equal(body.error.code, 'VALIDATION_ERROR');
});

// ---------- /me and the authenticate middleware ----------

test('/me with a valid token: 200 with fresh user data from the database', async () => {
  const { email, id } = await registeredUser();
  const login = await call('POST', '/api/auth/login', { body: { email, password: PASSWORD } });
  const { status, body } = await call('GET', '/api/auth/me', { token: login.accessToken });

  assert.equal(status, 200);
  assert.equal(body.user.id, id);
  assert.equal(body.user.email, email);
});

test('/me without a token: 401 AUTH_REQUIRED with WWW-Authenticate header', async () => {
  const { status, headers, body } = await call('GET', '/api/auth/me');
  assert.equal(status, 401);
  assert.equal(body.error.code, 'AUTH_REQUIRED');
  assert.equal(headers.get('www-authenticate'), 'Cookie realm="flash-sale-api"');
});

// Every one of these must be rejected with the given code.
const badTokens = [
  ['garbage', async () => 'not.a.jwt', 'INVALID_TOKEN'],
  [
    'tampered payload (role changed to admin, signature kept)',
    async () => {
      const [h, , s] = (await craftToken({ sub: '1' })).split('.');
      return `${h}.${b64url({ sub: '1', role: 'admin', iss: env.jwt.issuer, aud: env.jwt.audience, exp: 9999999999 })}.${s}`;
    },
    'INVALID_TOKEN',
  ],
  [
    '"alg": "none" (unsigned) token',
    async () =>
      `${b64url({ alg: 'none', typ: 'JWT' })}.${b64url({ sub: '1', role: 'admin', iss: env.jwt.issuer, aud: env.jwt.audience, exp: 9999999999 })}.`,
    'INVALID_TOKEN',
  ],
  [
    'signed with a different secret',
    () => craftToken({ sub: '1' }, { key: new TextEncoder().encode('x'.repeat(64)) }),
    'INVALID_TOKEN',
  ],
  ['wrong audience', () => craftToken({ sub: '1', aud: 'some-other-app' }), 'INVALID_TOKEN'],
  ['wrong issuer', () => craftToken({ sub: '1', iss: 'evil-issuer' }), 'INVALID_TOKEN'],
  ['unknown role', () => craftToken({ sub: '1', role: 'superuser' }), 'INVALID_TOKEN'],
  [
    'expired',
    () => craftToken({ sub: '1' }, { exp: Math.floor(Date.now() / 1000) - 60 }),
    'TOKEN_EXPIRED',
  ],
];

for (const [name, makeToken, code] of badTokens) {
  test(`/me rejects: ${name} → 401 ${code}`, async () => {
    const { status, body } = await call('GET', '/api/auth/me', { token: await makeToken() });
    assert.equal(status, 401);
    assert.equal(body.error.code, code);
  });
}

test('a VALID token sent as "Authorization: Bearer" is ignored: cookies are the only way in', async () => {
  const { email } = await registeredUser();
  const { accessToken } = await call('POST', '/api/auth/login', { body: { email, password: PASSWORD } });

  const res = await fetch(`${baseUrl}/api/auth/me`, { headers: { Authorization: `Bearer ${accessToken}` } });
  assert.equal(res.status, 401);
  assert.equal((await res.json()).error.code, 'AUTH_REQUIRED');
});

test('/me with a valid token for a deleted user → 401', async () => {
  const { email, id } = await registeredUser();
  const login = await call('POST', '/api/auth/login', { body: { email, password: PASSWORD } });
  await pool.query('DELETE FROM users WHERE id = $1', [id]);

  const { status } = await call('GET', '/api/auth/me', { token: login.accessToken });
  assert.equal(status, 401);
});

// ---------- startup safety ----------

function startEnvWith(secret) {
  return spawnSync(process.execPath, ['--input-type=module', '-e', "await import('./src/config/env.js')"], {
    cwd: new URL('..', import.meta.url),
    env: { ...process.env, JWT_ACCESS_SECRET: secret },
    encoding: 'utf8',
  });
}

test('server refuses to start with a missing or short JWT secret', () => {
  const missing = startEnvWith('');
  assert.notEqual(missing.status, 0);
  assert.match(missing.stderr, /Missing required environment variable: JWT_ACCESS_SECRET/);

  const short = startEnvWith('too-short');
  assert.notEqual(short.status, 0);
  assert.match(short.stderr, /JWT_ACCESS_SECRET must be at least 32 bytes/);
});
