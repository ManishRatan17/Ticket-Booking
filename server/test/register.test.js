// POST /api/auth/register, tested through real HTTP. Requires `docker compose up -d`.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createApp } from '../src/app.js';
import { pool } from '../src/config/db.js';
import { runMigrations } from '../src/db/migrate.js';
import { closeConnections } from '../src/config/connections.js';

// Every email in this run starts with this prefix, so cleanup deletes only our test users.
const RUN = `test-reg-${randomUUID().slice(0, 8)}`;
let counter = 0;
const newEmail = () => `${RUN}-${++counter}@example.com`;
const GOOD_PASSWORD = 'correct horse battery staple';

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

async function register(body) {
  const res = await fetch(`${baseUrl}/api/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

test('201: creates the user, email normalised, no hash in the response', async () => {
  const email = newEmail();
  const { status, body } = await register({ email: `  ${email.toUpperCase()} `, password: GOOD_PASSWORD });

  assert.equal(status, 201);
  assert.equal(body.user.email, email);
  assert.equal(body.user.role, 'user');
  assert.equal(typeof body.user.id, 'number');
  assert.deepEqual(Object.keys(body.user).sort(), ['createdAt', 'email', 'id', 'role']);
});

test('the database stores an argon2id hash, never the password', async () => {
  const email = newEmail();
  await register({ email, password: GOOD_PASSWORD });

  const { rows } = await pool.query('SELECT password_hash FROM users WHERE email = $1', [email]);
  assert.match(rows[0].password_hash, /^\$argon2id\$/);
  assert.ok(!rows[0].password_hash.includes(GOOD_PASSWORD));
});

test('409 EMAIL_TAKEN for a duplicate email, even with different capitals', async () => {
  const email = newEmail();
  assert.equal((await register({ email, password: GOOD_PASSWORD })).status, 201);

  const again = await register({ email: email.toUpperCase(), password: GOOD_PASSWORD });
  assert.equal(again.status, 409);
  assert.equal(again.body.error.code, 'EMAIL_TAKEN');
});

test('race: 20 parallel registrations with one email → exactly one 201', async () => {
  const email = newEmail();
  const results = await Promise.all(
    Array.from({ length: 20 }, () => register({ email, password: GOOD_PASSWORD })),
  );
  const statuses = results.map((r) => r.status);

  assert.equal(statuses.filter((s) => s === 201).length, 1);
  assert.equal(statuses.filter((s) => s === 409).length, 19);
});

test('mass assignment: "role": "admin" in the body is ignored', async () => {
  const email = newEmail();
  const { status, body } = await register({ email, password: GOOD_PASSWORD, role: 'admin' });

  assert.equal(status, 201);
  assert.equal(body.user.role, 'user');
  const { rows } = await pool.query('SELECT role FROM users WHERE email = $1', [email]);
  assert.equal(rows[0].role, 'user');
});

// Each bad request → 400 VALIDATION_ERROR blaming the right field.
const invalidCases = [
  ['password too short', () => ({ email: newEmail(), password: 'short' }), 'body.password'],
  ['password too long', () => ({ email: newEmail(), password: 'x'.repeat(129) }), 'body.password'],
  ['common password', () => ({ email: newEmail(), password: 'QwertyUiop' }), 'body.password'],
  ['password = email', () => { const e = newEmail(); return { email: e, password: e.toUpperCase() }; }, 'body.password'],
  ['invalid email', () => ({ email: 'not-an-email', password: GOOD_PASSWORD }), 'body.email'],
  ['missing password', () => ({ email: newEmail() }), 'body.password'],
  ['password is a number', () => ({ email: newEmail(), password: 12345678901 }), 'body.password'],
];

for (const [name, makeBody, field] of invalidCases) {
  test(`400: ${name}`, async () => {
    const { status, body } = await register(makeBody());
    assert.equal(status, 400);
    assert.equal(body.error.code, 'VALIDATION_ERROR');
    assert.ok(
      body.error.details.some((d) => d.field === field),
      `expected an error on ${field}, got ${JSON.stringify(body.error.details)}`,
    );
  });
}
