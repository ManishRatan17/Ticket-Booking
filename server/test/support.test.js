// The support inbox: requests, messages, admin decisions, and "more tickets" raising the limit.
// Requires Docker.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createApp } from '../src/app.js';
import { env } from '../src/config/env.js';
import { pool } from '../src/config/db.js';
import { runMigrations } from '../src/db/migrate.js';
import { closeConnections } from '../src/config/connections.js';
import { createEvent } from '../src/modules/events/events.service.js';
import { signPayload, SIGNATURE_HEADER } from '../src/modules/payments/signature.js';
import { createSignedInUsers } from '../test-support/users.js';
import { deleteEventKeys } from '../test-support/redis-cleanup.js';
import { holdWhileCreatingAdmins } from '../test-support/admin-lock.js';

const RUN = `test-support-${randomUUID().slice(0, 8)}`;
let server, baseUrl, admin, admin2, releaseAdminsLock;
let n = 0;
const createdEventIds = [];

before(async () => {
  await runMigrations({ log: () => {} });
  server = createApp().listen(0);
  baseUrl = `http://localhost:${server.address().port}`;
  releaseAdminsLock = await holdWhileCreatingAdmins(); // see admin-lock.js
  [admin, admin2] = await createSignedInUsers(2, { prefix: `${RUN}-admin`, role: 'admin' });
});

after(async () => {
  try {
    await deleteEventKeys(createdEventIds);
    if (createdEventIds.length) {
      await pool.query('DELETE FROM sold_tickets WHERE event_id = ANY($1)', [createdEventIds]);
      await pool.query('DELETE FROM orders WHERE event_id = ANY($1)', [createdEventIds]);
      await pool.query('DELETE FROM events WHERE id = ANY($1)', [createdEventIds]);
    }
    await pool.query('DELETE FROM processed_webhooks WHERE webhook_id LIKE $1', [`${RUN}%`]);
    await pool.query('DELETE FROM users WHERE email LIKE $1', [`${RUN}%`]); // requests, messages, overrides cascade
  } finally {
    // Always let go of the lock and the connections, even if a cleanup step failed: otherwise the
    // process never exits (seen once: a failing cleanup left the run hanging).
    await releaseAdminsLock?.();
    server.close();
    await closeConnections();
  }
});

async function event() {
  const e = await createEvent({ name: `${RUN} event ${++n}`, totalTickets: 50, saleStartsAt: new Date(Date.now() - 60_000), pricePaise: 100 });
  createdEventIds.push(e.id);
  return e;
}
const users = (count) => createSignedInUsers(count, { prefix: `${RUN}-${++n}` });

async function api(method, path, { as, body, headers = {} } = {}) {
  const h = { ...headers };
  if (as) h.Cookie = as.cookie;
  if (body) h['Content-Type'] = 'application/json';
  const res = await fetch(`${baseUrl}${path}`, { method, headers: h, body: body && JSON.stringify(body) });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}
const askMore = (as, e, extraTickets = 2, message = 'Buying for my family of 6, please.') =>
  api('POST', '/api/support/requests', { as, body: { kind: 'more_tickets', eventId: e.id, extraTickets, message } });
const decide = (as, id, decision, message) => api('POST', `/api/admin/support/${id}/decision`, { as, body: { decision, message } });

// hold → order → paid (through the signed webhook, as the provider would)
async function buy(as, e, quantity) {
  const h = await api('POST', `/api/events/${e.id}/holds`, { as, body: { quantity } });
  if (h.status !== 201) return h;
  const order = (await api('POST', '/api/orders', { as, body: { holdId: h.body.hold.id }, headers: { 'Idempotency-Key': randomUUID() } })).body.order;
  const evt = { id: `${RUN}-evt-${randomUUID()}`, type: 'payment.succeeded', data: { orderId: order.id, paymentId: `pay_${randomUUID()}`, amountPaise: order.amountPaise } };
  const res = await fetch(`${baseUrl}/api/webhooks/payments`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', [SIGNATURE_HEADER]: signPayload(JSON.stringify(evt), env.payments.webhookSecret) },
    body: JSON.stringify(evt),
  });
  return { status: 201, outcome: (await res.json()).outcome };
}

// ---------- the person ----------

test('ask for more tickets → 201: open, with the first message; the person never sees admin ids or emails', async () => {
  const e = await event();
  const [ann] = await users(1);
  const res = await askMore(ann, e);
  assert.equal(res.status, 201);
  const r = res.body.request;
  assert.deepEqual([r.kind, r.status, r.eventId, r.eventName, r.extraTickets], ['more_tickets', 'open', e.id, e.name, 2]);
  assert.equal(r.messages.length, 1);
  assert.deepEqual([r.messages[0].fromAdmin, r.messages[0].body], [false, 'Buying for my family of 6, please.']);
  assert.equal(r.userEmail, undefined);
  assert.equal((await api('GET', '/api/support/requests', { as: ann })).body.requests.length, 1);
});

test('validation: more tickets needs an event and 1–4 extra; messages 1–2,000 characters; unknown event → 404', async () => {
  const e = await event();
  const [ann] = await users(1);
  const post = (body) => api('POST', '/api/support/requests', { as: ann, body });
  assert.equal((await post({ kind: 'more_tickets', extraTickets: 2, message: 'hi' })).status, 400);
  assert.equal((await post({ kind: 'more_tickets', eventId: e.id, extraTickets: 5, message: 'hi' })).status, 400);
  assert.equal((await post({ kind: 'question', message: '   ' })).status, 400);
  assert.equal((await post({ kind: 'question', message: 'x'.repeat(2001) })).status, 400);
  assert.equal((await post({ kind: 'refund_me', message: 'hi' })).status, 400);
  assert.equal((await post({ kind: 'more_tickets', eventId: 999999999, extraTickets: 1, message: 'hi' })).body.error.code, 'EVENT_NOT_FOUND');
  assert.equal((await post({ kind: 'question', message: 'When do doors open?' })).status, 201, 'a question needs no event');
});

test('one OPEN request per person, kind and event: asking again → 409 pointing at the first one', async () => {
  const e = await event();
  const [ann] = await users(1);
  const first = (await askMore(ann, e)).body.request;
  const again = await askMore(ann, e, 3);
  assert.equal(again.status, 409);
  assert.equal(again.body.error.code, 'REQUEST_EXISTS');
  assert.equal(again.body.error.details.requestId, first.id);
  // A question about the same event is a different kind: fine.
  assert.equal((await api('POST', '/api/support/requests', { as: ann, body: { kind: 'question', eventId: e.id, message: 'Parking?' } })).status, 201);
});

test('someone else\'s request → 404 (never 403: we don\'t even confirm it exists)', async () => {
  const e = await event();
  const [ann, bob] = await users(2);
  const r = (await askMore(ann, e)).body.request;
  assert.equal((await api('GET', `/api/support/requests/${r.id}`, { as: bob })).status, 404);
  assert.equal((await api('POST', `/api/support/requests/${r.id}/messages`, { as: bob, body: { body: 'hijack' } })).status, 404);
});

// ---------- admins ----------

test('admins only: a normal user → 403 on the admin inbox', async () => {
  const [ann] = await users(1);
  assert.equal((await api('GET', '/api/admin/support', { as: ann })).status, 403);
});

test('a conversation: the person writes, an admin answers, the person sees "from the organisers"', async () => {
  const e = await event();
  const [ann] = await users(1);
  const r = (await askMore(ann, e)).body.request;
  await api('POST', `/api/support/requests/${r.id}/messages`, { as: ann, body: { body: 'Any news?' } });

  const inbox = (await api('GET', '/api/admin/support?status=open', { as: admin })).body.requests;
  const mine = inbox.find((x) => x.id === r.id);
  assert.equal(mine.userEmail, ann.email, 'admins see who asked');
  assert.equal(mine.awaitingReply, true, 'the person spoke last');

  await api('POST', `/api/admin/support/${r.id}/messages`, { as: admin, body: { body: 'Looking at it today.' } });
  const thread = (await api('GET', `/api/support/requests/${r.id}`, { as: ann })).body.request.messages;
  assert.deepEqual(
    thread.map((m) => [m.fromAdmin, m.body]),
    [
      [false, 'Buying for my family of 6, please.'],
      [false, 'Any news?'],
      [true, 'Looking at it today.'],
    ],
  );
  assert.equal((await api('GET', `/api/admin/support/${r.id}`, { as: admin })).body.request.awaitingReply, false);
});

test('APPROVED "+2 tickets" → this person\'s limit for this event becomes 6, for holds AND payments', async () => {
  const e = await event();
  const [ann, bob] = await users(2);
  assert.equal((await buy(ann, e, 4)).outcome, 'paid');
  assert.equal((await api('POST', `/api/events/${e.id}/holds`, { as: ann, body: { quantity: 1 } })).body.error.code, 'PURCHASE_LIMIT');

  const r = (await askMore(ann, e, 2)).body.request;
  const decided = await decide(admin, r.id, 'approved', 'Approved: enjoy the show!');
  assert.equal(decided.status, 200);
  assert.equal(decided.body.request.status, 'approved');

  assert.deepEqual((await api('GET', `/api/events/${e.id}/holds/mine`, { as: ann })).body.purchase, { bought: 4, limit: 6 });
  assert.equal((await buy(ann, e, 2)).outcome, 'paid', 'the payment check (PostgreSQL) knows the new limit too');
  const over = await api('POST', `/api/events/${e.id}/holds`, { as: ann, body: { quantity: 1 } });
  assert.deepEqual(over.body.error.details, { bought: 6, limit: 6 });

  // Only Ann, only this event.
  assert.equal((await api('GET', `/api/events/${e.id}/holds/mine`, { as: bob })).body.purchase.limit, 4);
  const other = await event();
  assert.equal((await api('GET', `/api/events/${other.id}/holds/mine`, { as: ann })).body.purchase.limit, 4);
});

test('DECLINED → the limit stays 4; a decided request takes no more messages and can\'t be decided again', async () => {
  const e = await event();
  const [ann] = await users(1);
  const r = (await askMore(ann, e)).body.request;
  assert.equal((await decide(admin, r.id, 'declined', 'Sorry, the limit is the same for everyone.')).status, 200);

  assert.equal((await api('GET', `/api/events/${e.id}/holds/mine`, { as: ann })).body.purchase.limit, 4);
  assert.equal((await api('POST', `/api/support/requests/${r.id}/messages`, { as: ann, body: { body: 'Please?' } })).body.error.code, 'REQUEST_CLOSED');
  assert.equal((await decide(admin, r.id, 'approved')).body.error.code, 'REQUEST_NOT_OPEN');
  assert.equal((await askMore(ann, e)).status, 201, 'they may ask again: the old one is closed');
});

test('two admins deciding at the SAME moment: exactly one decision wins', async () => {
  const e = await event();
  const [ann] = await users(1);
  const r = (await askMore(ann, e, 1)).body.request;
  const results = await Promise.all([decide(admin, r.id, 'approved'), decide(admin2, r.id, 'declined')]);
  assert.deepEqual(results.map((x) => x.status).sort(), [200, 409]);
  const final = (await api('GET', `/api/admin/support/${r.id}`, { as: admin })).body.request.status;
  const limit = (await api('GET', `/api/events/${e.id}/holds/mine`, { as: ann })).body.purchase.limit;
  assert.equal(limit, final === 'approved' ? 5 : 4, 'the limit matches the decision that won');
});

test('a question can be closed, not approved', async () => {
  const [ann] = await users(1);
  const q = (await api('POST', '/api/support/requests', { as: ann, body: { kind: 'question', message: 'Is there parking?' } })).body.request;
  assert.equal((await decide(admin, q.id, 'approved')).body.error.code, 'NOT_APPROVABLE');
  const closed = await decide(admin, q.id, 'closed', 'Yes, at gate B.');
  assert.equal(closed.body.request.status, 'closed');
  assert.equal(closed.body.request.messages.at(-1).body, 'Yes, at gate B.');
});

test('if an event is ever deleted, its requests (the conversation history) are kept, without the event', async () => {
  const e = await event();
  const [ann] = await users(1);
  const r = (await askMore(ann, e)).body.request;
  await pool.query('DELETE FROM events WHERE id = $1', [e.id]); // (no API does this; an operator might)
  createdEventIds.splice(createdEventIds.indexOf(e.id), 1);
  const kept = (await api('GET', `/api/support/requests/${r.id}`, { as: ann })).body.request;
  assert.deepEqual([kept.kind, kept.eventId, kept.messages.length], ['more_tickets', null, 1]);
});
