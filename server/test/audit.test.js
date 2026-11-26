// The admin audit log: every successful admin change is recorded; nothing can rewrite it. Requires Docker.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createApp } from '../src/app.js';
import { pool } from '../src/config/db.js';
import { runMigrations } from '../src/db/migrate.js';
import { closeConnections } from '../src/config/connections.js';
import { changeRoleByEmail } from '../src/modules/admin/admin.service.js';
import { createSignedInUsers } from '../test-support/users.js';
import { holdWhileCreatingAdmins } from '../test-support/admin-lock.js';
import { deleteEventKeys } from '../test-support/redis-cleanup.js';

const RUN = `test-audit-${randomUUID().slice(0, 8)}`;
let server, baseUrl, admin, releaseAdminsLock;
let n = 0;

before(async () => {
  await runMigrations({ log: () => {} });
  server = createApp().listen(0);
  baseUrl = `http://localhost:${server.address().port}`;
  releaseAdminsLock = await holdWhileCreatingAdmins();
  [admin] = await createSignedInUsers(1, { prefix: `${RUN}-admin`, role: 'admin' });
});

after(async () => {
  try {
    const { rows } = await pool.query('SELECT id FROM events WHERE name LIKE $1', [`${RUN}%`]);
    await deleteEventKeys(rows.map((r) => r.id));
    await pool.query('DELETE FROM events WHERE name LIKE $1', [`${RUN}%`]);
    // (the audit entries stay: append-only, and this is the test database)
    await pool.query("UPDATE users SET role = 'user' WHERE email LIKE $1", [`${RUN}%`]);
    await pool.query('DELETE FROM users WHERE email LIKE $1', [`${RUN}%`]);
  } finally {
    await releaseAdminsLock?.();
    server.close();
    await closeConnections();
  }
});

const users = (count) => createSignedInUsers(count, { prefix: `${RUN}-${++n}` });
async function api(method, path, { as, body } = {}) {
  const headers = {};
  if (as) headers.Cookie = as.cookie;
  if (body) headers['Content-Type'] = 'application/json';
  const res = await fetch(`${baseUrl}${path}`, { method, headers, body: body && JSON.stringify(body) });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}
// Entries are written just after the response (once its success is known): wait for them.
async function entriesFor(targetType, targetId, expected = 1) {
  for (let i = 0; i < 100; i++) {
    const { rows } = await pool.query(
      'SELECT * FROM admin_audit_log WHERE target_type = $1 AND target_id = $2 ORDER BY id',
      [targetType, String(targetId)],
    );
    if (rows.length >= expected) return rows;
    await new Promise((r) => setTimeout(r, 20));
  }
  return (await pool.query('SELECT * FROM admin_audit_log WHERE target_type = $1 AND target_id = $2', [targetType, String(targetId)])).rows;
}

test('a role change is recorded: which admin (and their email), what, to whom, details', async () => {
  const [ann] = await users(1);
  assert.equal((await api('PATCH', `/api/admin/users/${ann.id}/role`, { as: admin, body: { role: 'admin' } })).status, 200);
  const [entry] = await entriesFor('user', ann.id);
  assert.deepEqual(
    [entry.action, Number(entry.admin_id), entry.admin_email, entry.details.role],
    ['role.change', admin.id, admin.email, 'admin'],
  );
});

test('creating and editing an event are recorded; the new event\'s id is the target', async () => {
  const created = await api('POST', '/api/admin/events', {
    as: admin,
    body: { name: `${RUN} concert`, totalTickets: 10, saleStartsAt: new Date(Date.now() + 3_600_000).toISOString() },
  });
  const id = created.body.event.id;
  await api('PATCH', `/api/admin/events/${id}`, { as: admin, body: { pricePaise: 12_300 } });
  const entries = await entriesFor('event', id, 2);
  assert.deepEqual(entries.map((e) => e.action), ['event.create', 'event.update']);
  assert.equal(entries[1].details.pricePaise, 12_300);
});

test('FAILED actions and reads are not recorded', async () => {
  const created = await api('POST', '/api/admin/events', {
    as: admin,
    body: { name: `${RUN} on sale`, totalTickets: 5, saleStartsAt: new Date(Date.now() - 60_000).toISOString() },
  });
  const id = created.body.event.id;
  assert.equal((await api('PATCH', `/api/admin/events/${id}`, { as: admin, body: { pricePaise: 1 } })).body.error.code, 'SALE_STARTED');
  await api('GET', `/api/admin/events/${id}`, { as: admin });
  await new Promise((r) => setTimeout(r, 200));
  const entries = await entriesFor('event', id);
  assert.deepEqual(entries.map((e) => e.action), ['event.create'], 'only the create');
});

test('a change from the command line (set-role) is recorded as "command line"', async () => {
  const [bob] = await users(1);
  await changeRoleByEmail({ email: bob.email, role: 'admin' });
  const [entry] = await entriesFor('user', bob.id);
  assert.deepEqual([entry.action, entry.admin_id, entry.admin_email], ['role.change', null, 'command line (set-role)']);
});

test('APPEND-ONLY: the database refuses to change or delete an entry', async () => {
  const { rows } = await pool.query('SELECT id FROM admin_audit_log ORDER BY id DESC LIMIT 1');
  await assert.rejects(pool.query("UPDATE admin_audit_log SET action = 'nothing' WHERE id = $1", [rows[0].id]), /append-only/);
  await assert.rejects(pool.query('DELETE FROM admin_audit_log WHERE id = $1', [rows[0].id]), /append-only/);
});

test('admins read it (newest first, filter by action); normal users → 403', async () => {
  const list = (await api('GET', '/api/admin/audit?action=role.change', { as: admin })).body.entries;
  assert.ok(list.length >= 1 && list.every((e) => e.action === 'role.change'));
  assert.ok(new Date(list[0].createdAt) >= new Date(list.at(-1).createdAt));
  const [carol] = await users(1);
  assert.equal((await api('GET', '/api/admin/audit', { as: carol })).status, 403);
});
