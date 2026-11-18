// Roles and authorization. Requires `docker compose up -d`.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { decodeJwt } from 'jose';
import { createApp } from '../src/app.js';
import { pool } from '../src/config/db.js';
import { runMigrations } from '../src/db/migrate.js';
import { closeConnections } from '../src/config/connections.js';

const RUN = `test-admin-${randomUUID().slice(0, 8)}`;
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

async function api(method, path, { token, cookie, body } = {}) {
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  if (cookie) headers.Cookie = `refresh_token=${encodeURIComponent(cookie)}`;
  if (body) headers['Content-Type'] = 'application/json';
  const res = await fetch(`${baseUrl}${path}`, { method, headers, body: body && JSON.stringify(body) });
  const text = await res.text();
  const raw = res.headers.getSetCookie().find((c) => c.startsWith('refresh_token='));
  return {
    status: res.status,
    body: text ? JSON.parse(text) : null,
    refreshToken: raw ? decodeURIComponent(raw.split(';')[0].slice('refresh_token='.length)) : null,
  };
}

// Registers a user, optionally makes them admin (directly in the DB: test setup only),
// then logs in so the token carries that role.
async function newUser({ admin = false } = {}) {
  const email = `${RUN}-${++counter}@example.com`;
  const { body } = await api('POST', '/api/auth/register', { body: { email, password: PASSWORD } });
  if (admin) await pool.query(`UPDATE users SET role = 'admin' WHERE id = $1`, [body.user.id]);
  return { id: body.user.id, email, ...(await login(email)) };
}

async function login(email) {
  const res = await api('POST', '/api/auth/login', { body: { email, password: PASSWORD } });
  return { accessToken: res.body.accessToken, refreshToken: res.refreshToken };
}

const setRole = (actor, targetId, role) =>
  api('PATCH', `/api/admin/users/${targetId}/role`, { token: actor.accessToken, body: { role } });

// "Last admin" depends on EVERY admin in the database. Tests share the dev database,
// so: demote this run's leftover admins, then check nobody else is an admin.
async function noOtherAdmins(t) {
  await pool.query(`UPDATE users SET role = 'user' WHERE email LIKE $1`, [`${RUN}-%`]);
  const { rows } = await pool.query(`SELECT count(*)::int AS n FROM users WHERE role = 'admin'`);
  if (rows[0].n > 0) {
    t.skip(`${rows[0].n} admin(s) already exist in the dev database; this test needs none`);
    return false;
  }
  return true;
}

// ---------- 401 vs 403 ----------

test('admin route without a token → 401 (who are you?)', async () => {
  const res = await api('GET', '/api/admin/users');
  assert.equal(res.status, 401);
  assert.equal(res.body.error.code, 'AUTH_REQUIRED');
});

test('admin route as a normal user → 403 (we know you; the answer is no)', async () => {
  const user = await newUser();
  const res = await api('GET', '/api/admin/users', { token: user.accessToken });
  assert.equal(res.status, 403);
  assert.equal(res.body.error.code, 'FORBIDDEN');
});

test('a normal user cannot change roles, not even their own', async () => {
  const user = await newUser();
  const res = await setRole(user, user.id, 'admin');
  assert.equal(res.status, 403);
  const { rows } = await pool.query('SELECT role FROM users WHERE id = $1', [user.id]);
  assert.equal(rows[0].role, 'user');
});

// ---------- listing users ----------

test('admin lists users: safe fields only, with login methods', async () => {
  const admin = await newUser({ admin: true });
  const res = await api('GET', '/api/admin/users?limit=100', { token: admin.accessToken });
  assert.equal(res.status, 200);

  const me = res.body.users.find((u) => u.id === admin.id);
  assert.deepEqual(Object.keys(me).sort(), ['createdAt', 'email', 'hasGoogle', 'hasPassword', 'id', 'role']);
  assert.equal(me.role, 'admin');
  assert.equal(me.hasPassword, true);
  assert.equal(me.hasGoogle, false);
  assert.ok(!JSON.stringify(res.body).includes('argon2'), 'a password hash leaked');
});

test('pagination: limit/offset work and the total is reported', async () => {
  const admin = await newUser({ admin: true });
  const page1 = await api('GET', '/api/admin/users?limit=1&offset=0', { token: admin.accessToken });
  const page2 = await api('GET', '/api/admin/users?limit=1&offset=1', { token: admin.accessToken });

  assert.equal(page1.body.users.length, 1);
  assert.equal(page2.body.users.length, 1);
  assert.notEqual(page1.body.users[0].id, page2.body.users[0].id);
  assert.ok(page1.body.total >= 2);
  assert.equal(page1.body.limit, 1);
});

test('pagination limits: too many, negative or non-numeric → 400', async () => {
  const admin = await newUser({ admin: true });
  for (const qs of ['limit=1000', 'limit=0', 'offset=-1', 'limit=abc']) {
    const res = await api('GET', `/api/admin/users?${qs}`, { token: admin.accessToken });
    assert.equal(res.status, 400, qs);
  }
});

// ---------- changing roles ----------

test('promotion takes effect at the next refresh (no need to revoke anything)', async () => {
  const admin = await newUser({ admin: true });
  const user = await newUser();

  assert.equal((await setRole(admin, user.id, 'admin')).status, 200);

  // The old token is a snapshot from login: it still says "user".
  assert.equal(decodeJwt(user.accessToken).role, 'user');
  assert.equal((await api('GET', '/api/admin/users', { token: user.accessToken })).status, 403);

  // Refresh reads the role from the DATABASE, so the new token says "admin".
  const refreshed = await api('POST', '/api/auth/refresh', { cookie: user.refreshToken });
  assert.equal(decodeJwt(refreshed.body.accessToken).role, 'admin');
  assert.equal((await api('GET', '/api/admin/users', { token: refreshed.body.accessToken })).status, 200);
});

test('demotion is INSTANT: all of the demoted admin\'s sessions die at once', async () => {
  const admin = await newUser({ admin: true });
  const other = await newUser({ admin: true });

  const res = await setRole(admin, other.id, 'user');
  assert.equal(res.status, 200);
  assert.equal(res.body.user.role, 'user');

  // Their token still SAYS "admin" — but the session behind it is gone.
  const attempt = await api('GET', '/api/admin/users', { token: other.accessToken });
  assert.equal(attempt.status, 401);
  assert.equal(attempt.body.error.code, 'SESSION_REVOKED');
  assert.equal((await api('POST', '/api/auth/refresh', { cookie: other.refreshToken })).status, 401);

  // Logging in again gives a token with the NEW role.
  const again = await login(other.email);
  assert.equal(decodeJwt(again.accessToken).role, 'user');
  assert.equal((await api('GET', '/api/admin/users', { token: again.accessToken })).status, 403);
});

test('bad input: unknown user → 404, bad id or role → 400', async () => {
  const admin = await newUser({ admin: true });
  const missing = await setRole(admin, 999999999, 'user');
  assert.equal(missing.status, 404);
  assert.equal(missing.body.error.code, 'USER_NOT_FOUND');

  assert.equal((await setRole(admin, 'abc', 'user')).status, 400);
  assert.equal((await setRole(admin, admin.id, 'superuser')).status, 400);
});

// ---------- the last admin ----------

test('the last admin cannot be demoted → 409 LAST_ADMIN', async (t) => {
  if (!(await noOtherAdmins(t))) return;
  const admin = await newUser({ admin: true });

  const res = await setRole(admin, admin.id, 'user');
  assert.equal(res.status, 409);
  assert.equal(res.body.error.code, 'LAST_ADMIN');
});

test('race: two admins demote each other at the same instant → exactly one succeeds', async (t) => {
  if (!(await noOtherAdmins(t))) return;
  const a = await newUser({ admin: true });
  const b = await newUser({ admin: true });

  const results = await Promise.all([setRole(a, b.id, 'user'), setRole(b, a.id, 'user')]);
  const statuses = results.map((r) => r.status);

  assert.equal(statuses.filter((s) => s === 200).length, 1, `statuses: ${statuses}`);
  const { rows } = await pool.query(`SELECT count(*)::int AS n FROM users WHERE role = 'admin'`);
  assert.equal(rows[0].n, 1, 'there must always be exactly one admin left');
});

// The HTTP race above is realistic but GENTLE: each request passes `authenticate` first,
// so in practice one transaction often finishes before the other starts. (Mutation testing
// showed it: with the row lock removed, that test still passed.) This one calls the service
// directly, 10 times, so both transactions really overlap — the worst case the lock must survive.
test('race (service level, 10 rounds): mutual demotion never leaves zero admins', async (t) => {
  if (!(await noOtherAdmins(t))) return;
  const { changeRole } = await import('../src/modules/admin/admin.service.js');

  for (let round = 1; round <= 10; round++) {
    await pool.query(`UPDATE users SET role = 'user' WHERE email LIKE $1`, [`${RUN}-%`]);
    const a = await newUser({ admin: true });
    const b = await newUser({ admin: true });

    const outcomes = await Promise.allSettled([
      changeRole({ actorId: a.id, targetId: b.id, role: 'user' }),
      changeRole({ actorId: b.id, targetId: a.id, role: 'user' }),
    ]);

    assert.equal(outcomes.filter((o) => o.status === 'fulfilled').length, 1, `round ${round}`);
    const { rows } = await pool.query(`SELECT count(*)::int AS n FROM users WHERE role = 'admin'`);
    assert.equal(rows[0].n, 1, `round ${round}: admins left`);
  }
});

// ---------- the command-line script ----------

function runSetRole(...args) {
  return spawnSync(process.execPath, ['--env-file=.env', 'scripts/set-role.js', ...args], {
    cwd: new URL('..', import.meta.url),
    encoding: 'utf8',
  });
}

test('set-role script: promotes by email, and fails clearly on bad input', async () => {
  const user = await newUser();

  const ok = runSetRole(user.email.toUpperCase(), 'admin');
  assert.equal(ok.status, 0, ok.stderr);
  assert.match(ok.stdout, /is now: admin/);
  const { rows } = await pool.query('SELECT role FROM users WHERE id = $1', [user.id]);
  assert.equal(rows[0].role, 'admin');

  const unknown = runSetRole(`${RUN}-nobody@example.com`, 'admin');
  assert.equal(unknown.status, 1);
  assert.match(unknown.stderr, /No user with email/);

  const badRole = runSetRole(user.email, 'superuser');
  assert.equal(badRole.status, 1);
  assert.match(badRole.stderr, /Usage/);
});
