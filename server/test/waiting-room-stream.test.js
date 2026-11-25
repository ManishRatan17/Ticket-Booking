// Live queue position over Server-Sent Events. Requires Docker.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createApp } from '../src/app.js';
import { pool } from '../src/config/db.js';
import { redis } from '../src/config/redis.js';
import { runMigrations } from '../src/db/migrate.js';
import { closeConnections } from '../src/config/connections.js';
import { createEvent } from '../src/modules/events/events.service.js';
import { admitWaiting } from '../src/jobs/processors.js';
import { ACTIVE_ROOMS, passKey as roomPassKey, queueKey, roomKeysPattern, streamsKey } from '../src/modules/waiting-room/waiting-room.js';
import { createSignedInUsers } from '../test-support/users.js';
import { deleteEventKeys } from '../test-support/redis-cleanup.js';

const RUN = `test-wrstream-${randomUUID().slice(0, 8)}`;
let server, baseUrl;
let n = 0;
const createdEventIds = [];

before(async () => {
  await runMigrations({ log: () => {} });
  server = createApp().listen(0);
  baseUrl = `http://localhost:${server.address().port}`;
});

after(async () => {
  for (const id of createdEventIds) {
    const keys = [];
    for await (const batch of redis.scanStream({ match: roomKeysPattern(id), count: 1000 })) keys.push(...batch);
    if (keys.length) await redis.del(...keys);
    await redis.srem(ACTIVE_ROOMS, String(id));
  }
  await deleteEventKeys(createdEventIds);
  if (createdEventIds.length) await pool.query('DELETE FROM events WHERE id = ANY($1)', [createdEventIds]);
  await pool.query('DELETE FROM users WHERE email LIKE $1', [`${RUN}%`]);
  server.close();
  await closeConnections();
});

async function event(rate = 1) {
  const e = await createEvent({ name: `${RUN} event ${++n}`, totalTickets: 50, saleStartsAt: new Date(Date.now() - 60_000), admissionPerSecond: rate });
  createdEventIds.push(e.id);
  return e;
}
const users = (count) => createSignedInUsers(count, { prefix: `${RUN}-${++n}` });
const join = (as, eventId) => fetch(`${baseUrl}/api/events/${eventId}/queue`, { method: 'POST', headers: { Cookie: as.cookie } });

// Opens the stream and returns a reader that yields parsed SSE messages one by one.
async function openStream(as, eventId) {
  const res = await fetch(`${baseUrl}/api/events/${eventId}/queue/stream`, { headers: { Cookie: as.cookie } });
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  async function next(timeoutMs = 5000) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const end = buffer.indexOf('\n\n'); // one message ends with a blank line
      if (end >= 0) {
        const block = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        const fields = Object.fromEntries(
          block.split('\n').filter((l) => l && !l.startsWith(':')).map((l) => [l.slice(0, l.indexOf(':')), l.slice(l.indexOf(':') + 1).trim()]),
        );
        if (fields.event === 'status') return JSON.parse(fields.data);
        continue; // retry: / ping lines
      }
      if (Date.now() > deadline) throw new Error('no message in time');
      const { value, done } = await reader.read();
      if (done) return null; // the server ended the stream
      buffer += decoder.decode(value, { stream: true });
    }
  }
  return { res, next, close: () => reader.cancel() };
}

test('the stream is real SSE: text/event-stream, first message = your current status', async () => {
  const e = await event();
  const [ann] = await users(1);
  await join(ann, e.id);

  const stream = await openStream(ann, e.id);
  assert.equal(stream.res.status, 200);
  assert.match(stream.res.headers.get('content-type'), /^text\/event-stream/);
  const first = await stream.next();
  assert.deepEqual([first.status, first.position], ['waiting', 1]);
  await stream.close();
});

test('live: your position updates as people ahead are let in, then "admitted" and the stream ends', async () => {
  const e = await event(1);
  const [ahead, ann] = await users(2);
  await join(ahead, e.id);
  await join(ann, e.id);

  const stream = await openStream(ann, e.id);
  assert.equal((await stream.next()).position, 2);

  await admitWaiting({ eventIds: [e.id] }); // lets in the person ahead
  assert.equal((await stream.next()).position, 1, 'moved up without asking');

  await admitWaiting({ eventIds: [e.id] }); // lets ann in
  assert.equal((await stream.next()).status, 'admitted');
  assert.equal(await stream.next(), null, 'the server closes the stream once you are in');
});

test('not in the queue → the stream says so', async () => {
  const e = await event();
  const [ann] = await users(1);
  const stream = await openStream(ann, e.id);
  assert.equal((await stream.next()).status, 'not_in_queue');
  await stream.close();
});

test('stream without being signed in → 401; for an event without a room → 409 (plain JSON)', async () => {
  const e = await event();
  assert.equal((await fetch(`${baseUrl}/api/events/${e.id}/queue/stream`)).status, 401);

  const open = await createEvent({ name: `${RUN} open`, totalTickets: 5, saleStartsAt: new Date() });
  createdEventIds.push(open.id);
  const [ann] = await users(1);
  const res = await fetch(`${baseUrl}/api/events/${open.id}/queue/stream`, { headers: { Cookie: ann.cookie } });
  assert.equal(res.status, 409);
  assert.equal((await res.json()).error.code, 'NO_WAITING_ROOM');
});

// ---------- Phase 5c: at most 3 live streams per user ----------

// The server notices a closed stream a moment later (the 'close' event): wait for the count.
async function waitForStreamCount(userId, expected, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const count = Number((await redis.get(streamsKey(userId))) ?? 0);
    if (count === expected || Date.now() > deadline) return count;
    await new Promise((r) => setTimeout(r, 25));
  }
}

test('3 streams per user: the 4th → 429 TOO_MANY_STREAMS (JSON); closing one frees a slot; others unaffected', async () => {
  const e = await event();
  const [ann, bob] = await users(2);
  await join(ann, e.id);

  const tabs = [await openStream(ann, e.id), await openStream(ann, e.id), await openStream(ann, e.id)];
  for (const tab of tabs) assert.equal(tab.res.status, 200);
  assert.equal(await redis.get(streamsKey(ann.id)), '3');
  const ttl = await redis.ttl(streamsKey(ann.id));
  assert.ok(ttl > 600 && ttl <= 900, `the count must expire by itself (TTL ${ttl})`);

  const fourth = await fetch(`${baseUrl}/api/events/${e.id}/queue/stream`, { headers: { Cookie: ann.cookie } });
  assert.equal(fourth.status, 429);
  assert.equal((await fourth.json()).error.code, 'TOO_MANY_STREAMS');
  assert.equal(await redis.get(streamsKey(ann.id)), '3', 'a refused stream is not counted');

  const bobs = await openStream(bob, e.id); // another person has their own slots
  assert.equal(bobs.res.status, 200);
  await bobs.close();

  await tabs[0].close();
  assert.equal(await waitForStreamCount(ann.id, 2), 2, 'closing a tab gives its slot back');
  const again = await openStream(ann, e.id);
  assert.equal(again.res.status, 200);

  await Promise.all([again.close(), tabs[1].close(), tabs[2].close()]);
  assert.equal(await waitForStreamCount(ann.id, 0), 0);
  assert.equal(await redis.exists(streamsKey(ann.id)), 0, 'at 0 the key is deleted (never negative)');
});

test('10 tabs opening at the same instant → exactly 3 streams', async () => {
  const e = await event();
  const [ann] = await users(1);
  const opened = await Promise.all(Array.from({ length: 10 }, () => openStream(ann, e.id)));
  const statuses = opened.map((s) => s.res.status);
  assert.equal(statuses.filter((s) => s === 200).length, 3, String(statuses));
  assert.equal(statuses.filter((s) => s === 429).length, 7);
  await Promise.all(opened.filter((s) => s.res.status === 200).map((s) => s.close()));
  assert.equal(await waitForStreamCount(ann.id, 0), 0);
});

test('a stream that ends by itself (you were admitted) gives its slot back too', async () => {
  const e = await event(1);
  const [ann] = await users(1);
  await join(ann, e.id);
  const stream = await openStream(ann, e.id);
  await stream.next();
  await admitWaiting({ eventIds: [e.id] });
  assert.equal((await stream.next()).status, 'admitted');
  assert.equal(await stream.next(), null);
  assert.equal(await waitForStreamCount(ann.id, 0), 0);
});
