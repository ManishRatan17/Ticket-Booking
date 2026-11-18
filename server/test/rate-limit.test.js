// Rate limiting. Requires `docker compose up -d`.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

// .env.test switches rate limits OFF for the rest of the suite; this file turns them back
// ON, with its own Redis key prefix (so runs never see each other's counters), and trusts
// the loopback proxy so each test can pretend to be a different IP via X-Forwarded-For.
// Set BEFORE the app is imported, because env.js reads process.env once.
const PREFIX = `ratelimit-test-${randomUUID().slice(0, 8)}`;
Object.assign(process.env, { RATE_LIMITS_ENABLED: 'true', RATE_LIMIT_PREFIX: PREFIX, TRUST_PROXY: 'loopback' });

const { createApp } = await import('../src/app.js');
const { pool } = await import('../src/config/db.js');
const { redis } = await import('../src/config/redis.js');
const { runMigrations } = await import('../src/db/migrate.js');
const { closeConnections } = await import('../src/config/connections.js');
const { hashPassword } = await import('../src/modules/auth/password.js');
const { createLimiter } = await import('../src/lib/rateLimiter.js');

await runMigrations({ log: () => {} });
const server = createApp().listen(0);
const baseUrl = `http://localhost:${server.address().port}`;

const RUN = `test-ratelimit-${randomUUID().slice(0, 8)}`;
const PASSWORD = 'correct horse battery staple';
let n = 0;
const newIp = () => `198.51.100.${++n}`; // a documentation-only IP range: never a real client

after(async () => {
  await pool.query('DELETE FROM users WHERE email LIKE $1', [`${RUN}-%`]);
  const keys = await redis.keys(`${PREFIX}:*`);
  if (keys.length) await redis.del(...keys);
  server.close();
  await closeConnections();
});

// Users are created straight in the database, so creating them doesn't use up
// the register limit that one of the tests below is measuring.
async function newUser() {
  const email = `${RUN}-${++n}@example.com`;
  await pool.query('INSERT INTO users (email, password_hash) VALUES ($1, $2)', [email, await hashPassword(PASSWORD)]);
  return email;
}

function post(path, ip, body) {
  return fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': ip },
    body: body && JSON.stringify(body),
  });
}

const login = (ip, email, password) => post('/api/auth/login', ip, { email, password });

// ---------- the counter itself ----------

test('Lua counter: 100 parallel hits with a limit of 10 → exactly 10 allowed, and the key expires', async () => {
  const limiter = createLimiter({ name: 'unit', limit: 10, windowSeconds: 60 });
  const id = randomUUID();
  const results = await Promise.all(Array.from({ length: 100 }, () => limiter.hit(id)));

  assert.equal(results.filter((r) => r.allowed).length, 10);
  const keys = await redis.keys(`${PREFIX}:unit:*`);
  const ttl = await redis.ttl(keys[0]);
  assert.ok(ttl > 0 && ttl <= 60, `counter must expire by itself, TTL was ${ttl}`);
});

// ---------- login ----------

test('login: 5 wrong passwords, then 429 — even with the RIGHT password', async () => {
  const ip = newIp();
  const email = await newUser();
  for (let i = 1; i <= 5; i++) {
    assert.equal((await login(ip, email, 'wrong password')).status, 401, `attempt ${i}`);
  }

  const blocked = await login(ip, email, PASSWORD);
  assert.equal(blocked.status, 429);
  assert.equal((await blocked.json()).error.code, 'RATE_LIMITED');
  const retryAfter = Number(blocked.headers.get('retry-after'));
  assert.ok(retryAfter > 890 && retryAfter <= 900, `Retry-After was ${retryAfter}`);
  assert.equal(blocked.headers.get('ratelimit-remaining'), '0');
});

test('login: the attacker locks only THEMSELVES out, not the victim', async () => {
  const email = await newUser();
  const attackerIp = newIp();
  for (let i = 0; i < 6; i++) await login(attackerIp, email, 'wrong password');
  assert.equal((await login(attackerIp, email, PASSWORD)).status, 429);

  // The real owner, from their own IP, logs in normally.
  assert.equal((await login(newIp(), email, PASSWORD)).status, 200);
});

test('login: a successful login resets the failure counter', async () => {
  const ip = newIp();
  const email = await newUser();
  for (let i = 0; i < 4; i++) await login(ip, email, 'wrong password');
  assert.equal((await login(ip, email, PASSWORD)).status, 200);

  // The reset happens just after the response is sent; give it a moment.
  await new Promise((resolve) => setTimeout(resolve, 100));
  for (let i = 1; i <= 5; i++) {
    assert.equal((await login(ip, email, 'wrong password')).status, 401, `attempt ${i} after reset`);
  }
});

test('login: 20 PARALLEL guesses → at most 5 ever reach the password check', async () => {
  const ip = newIp();
  const email = await newUser();
  const responses = await Promise.all(Array.from({ length: 20 }, () => login(ip, email, 'wrong password')));
  const statuses = responses.map((r) => r.status);

  assert.equal(statuses.filter((s) => s === 401).length, 5, `statuses: ${statuses}`);
  assert.equal(statuses.filter((s) => s === 429).length, 15);
});

test('login: one IP trying many accounts hits the per-IP limit (30 per 15 min)', async () => {
  const ip = newIp();
  const statuses = [];
  for (let i = 0; i < 31; i++) {
    statuses.push((await login(ip, `${RUN}-nobody-${i}@example.com`, 'whatever')).status);
  }
  assert.equal(statuses.filter((s) => s === 401).length, 30);
  assert.equal(statuses.at(-1), 429);
});

// ---------- other endpoints ----------

test('register: 5 per hour per IP, then 429', async () => {
  const ip = newIp();
  const statuses = [];
  for (let i = 0; i < 6; i++) {
    const res = await post('/api/auth/register', ip, { email: `${RUN}-reg-${i}@example.com`, password: PASSWORD });
    statuses.push(res.status);
  }
  assert.deepEqual(statuses, [201, 201, 201, 201, 201, 429]);
});

test('refresh: 60 per minute per IP, then 429', async () => {
  const ip = newIp();
  let last;
  for (let i = 0; i < 61; i++) last = await post('/api/auth/refresh', ip);
  assert.equal(last.status, 429);
});

test('Google start: 20 per minute per IP, then 429', async () => {
  const ip = newIp();
  let last;
  for (let i = 0; i < 21; i++) {
    last = await fetch(`${baseUrl}/api/auth/google`, { redirect: 'manual', headers: { 'X-Forwarded-For': ip } });
  }
  assert.equal(last.status, 429);
});

test('forgot password: 3 per hour per email — answered the same for unknown emails', async () => {
  const unknown = `${RUN}-nobody-forgot@example.com`;
  const statuses = [];
  for (let i = 0; i < 4; i++) statuses.push((await post('/api/auth/forgot-password', newIp(), { email: unknown })).status);
  // 4 different IPs, so only the per-EMAIL limit can explain the 429.
  assert.deepEqual(statuses, [200, 200, 200, 429]);
});

test('allowed requests carry the remaining budget in RateLimit-* headers', async () => {
  const ip = newIp();
  const first = await post('/api/auth/register', ip, { email: 'not-an-email', password: 'x' });
  const second = await post('/api/auth/register', ip, { email: 'not-an-email', password: 'x' });
  assert.equal(first.headers.get('ratelimit-limit'), '5');
  assert.equal(first.headers.get('ratelimit-remaining'), '4');
  assert.equal(second.headers.get('ratelimit-remaining'), '3', 'invalid requests count too');
});
