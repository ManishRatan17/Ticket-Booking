// Ticket holds in Redis: correctness under concurrency. Requires `docker compose up -d`.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { redis } from '../src/config/redis.js';
import { closeConnections } from '../src/config/connections.js';
import { setStock, getStock, stockKey } from '../src/modules/reservation/stock.js';
import {
  createHold,
  getHold,
  getUserHold,
  releaseHold,
  HOLD_SECONDS,
  MAX_TICKETS_PER_HOLD,
} from '../src/modules/reservation/holds.js';

// Every test uses its own event id, so tests never share stock. All keys removed at the end.
const RUN = `test-holds-${randomUUID().slice(0, 8)}`;
let n = 0;
async function newEvent(tickets) {
  const eventId = `${RUN}-${++n}`;
  await setStock(eventId, tickets);
  return eventId;
}

after(async () => {
  // Hold records don't contain the RUN prefix in their key, so find them by their eventId.
  const keys = [];
  for await (const batch of redis.scanStream({ match: `event:${RUN}-*`, count: 500 })) keys.push(...batch);
  for await (const batch of redis.scanStream({ match: 'hold:*', count: 500 })) {
    for (const key of batch) {
      if ((await redis.hget(key, 'eventId'))?.startsWith(RUN)) keys.push(key);
    }
  }
  for (let i = 0; i < keys.length; i += 500) await redis.del(...keys.slice(i, i + 500));
  await closeConnections();
});

// Pretend a hold was created long ago: move its expiry into the past.
const expire = (holdId) => redis.hset(`hold:${holdId}`, 'expiresAt', Date.now() - 1000);

// ---------- basics ----------

test('a hold takes tickets from stock and records who, how many and until when', async () => {
  const eventId = await newEvent(10);
  const result = await createHold({ eventId, userId: 7, quantity: 3 });

  assert.equal(result.status, 'held');
  assert.equal(await getStock(eventId), 7);

  const hold = await getHold(result.hold.id);
  assert.equal(hold.userId, 7);
  assert.equal(hold.quantity, 3);
  assert.equal(hold.expired, false);
  // expiresAt comes from REDIS's clock (inside Docker); Date.now() is THIS machine's clock.
  // They can differ by a few milliseconds, so allow a little slack in both directions.
  // (The code itself only ever compares Redis time with Redis time — see create-hold.lua.)
  const seconds = (hold.expiresAt - Date.now()) / 1000;
  assert.ok(seconds > HOLD_SECONDS - 5 && seconds <= HOLD_SECONDS + 2, `expires in ${seconds}s`);
  assert.equal((await getUserHold(eventId, 7)).id, result.hold.id);

  // No Redis TTL on the record: it must survive until it's RELEASED (see holds.js).
  assert.equal(await redis.ttl(`hold:${result.hold.id}`), -1);
});

test('quantity must be a whole number from 1 to 4; bad input never touches Redis', async () => {
  const eventId = await newEvent(10);
  for (const quantity of [0, -1, 5, 1.5, '2', null]) {
    await assert.rejects(createHold({ eventId, userId: 1, quantity }), /Invalid quantity/, `accepted ${quantity}`);
  }
  assert.equal(MAX_TICKETS_PER_HOLD, 4);
  assert.equal(await getStock(eventId), 10);
});

test('an event whose stock was never loaded → error (a bug), not "sold out"', async () => {
  await assert.rejects(createHold({ eventId: `${RUN}-missing`, userId: 1, quantity: 1 }), /No stock set up/);
});

// ---------- the rules ----------

test('one active hold per user per event: the second attempt gets the first hold back', async () => {
  const eventId = await newEvent(10);
  const first = await createHold({ eventId, userId: 5, quantity: 2 });
  const second = await createHold({ eventId, userId: 5, quantity: 4 });

  assert.deepEqual(second, { status: 'already_holding', holdId: first.hold.id });
  assert.equal(await getStock(eventId), 8, 'the refused attempt must not take tickets');
});

test('sold out: refused with how many are left, and nothing changes', async () => {
  const eventId = await newEvent(3);
  assert.deepEqual(await createHold({ eventId, userId: 1, quantity: 4 }), { status: 'sold_out', available: 3 });
  assert.equal(await getStock(eventId), 3);
  assert.equal(await getUserHold(eventId, 1), null);
});

test('lazy expiry: an expired hold of the SAME user is released when they hold again', async () => {
  const eventId = await newEvent(10);
  const old = await createHold({ eventId, userId: 9, quantity: 4 });
  await expire(old.hold.id);
  assert.equal((await getHold(old.hold.id)).expired, true);

  const fresh = await createHold({ eventId, userId: 9, quantity: 1 });
  assert.equal(fresh.status, 'held');
  assert.equal(await getStock(eventId), 9, 'old 4 tickets back, new 1 taken');
  assert.equal(await getHold(old.hold.id), null, 'the expired hold record is gone');
});

// ---------- releasing ----------

test('release returns the tickets; releasing again changes nothing (idempotent)', async () => {
  const eventId = await newEvent(10);
  const { hold } = await createHold({ eventId, userId: 3, quantity: 4 });

  assert.equal(await releaseHold(hold.id, { userId: 3 }), 'released');
  assert.equal(await getStock(eventId), 10);
  assert.equal(await getUserHold(eventId, 3), null);

  assert.equal(await releaseHold(hold.id, { userId: 3 }), 'not_found');
  assert.equal(await getStock(eventId), 10, 'tickets must come back ONCE');
});

test('only the owner can release a hold (the system can always)', async () => {
  const eventId = await newEvent(10);
  const { hold } = await createHold({ eventId, userId: 3, quantity: 2 });

  assert.equal(await releaseHold(hold.id, { userId: 4 }), 'not_owner');
  assert.ok(await getHold(hold.id), 'someone else must not be able to release it');
  assert.equal(await releaseHold(hold.id), 'released'); // e.g. the expiry worker
  assert.equal(await getStock(eventId), 10);
});

// ---------- concurrency (the point of the whole phase) ----------

test('1,000 users rush 100 tickets → exactly 100 holds, stock 0, every ticket accounted for', async () => {
  const eventId = await newEvent(100);
  const results = await Promise.all(
    Array.from({ length: 1000 }, (_, i) => createHold({ eventId, userId: i + 1, quantity: 1 })),
  );

  const held = results.filter((r) => r.status === 'held');
  assert.equal(held.length, 100);
  assert.equal(results.filter((r) => r.status === 'sold_out').length, 900);
  assert.equal(await getStock(eventId), 0);
  assert.equal(new Set(held.map((r) => r.hold.userId)).size, 100, 'each hold belongs to a different user');
});

test('mixed quantities: tickets are conserved and nobody is wrongly refused', async () => {
  const eventId = await newEvent(100);
  const wants = Array.from({ length: 300 }, () => 1 + Math.floor(Math.random() * 4));
  const results = await Promise.all(wants.map((quantity, i) => createHold({ eventId, userId: i + 1, quantity })));
  const left = await getStock(eventId);

  const heldTickets = results.reduce((sum, r, i) => (r.status === 'held' ? sum + wants[i] : sum), 0);
  assert.equal(heldTickets + left, 100, 'tickets were created or destroyed');
  results.forEach((r, i) => {
    if (r.status === 'sold_out') assert.ok(wants[i] > left, `user wanting ${wants[i]} refused while ${left} left`);
  });
});

test('one user, 50 parallel clicks → exactly ONE hold', async () => {
  const eventId = await newEvent(100);
  const results = await Promise.all(Array.from({ length: 50 }, () => createHold({ eventId, userId: 42, quantity: 2 })));

  assert.equal(results.filter((r) => r.status === 'held').length, 1);
  assert.equal(results.filter((r) => r.status === 'already_holding').length, 49);
  assert.equal(await getStock(eventId), 98);
});

test('20 parallel releases of one hold → tickets returned exactly once', async () => {
  const eventId = await newEvent(10);
  const { hold } = await createHold({ eventId, userId: 1, quantity: 4 });
  const results = await Promise.all(Array.from({ length: 20 }, () => releaseHold(hold.id, { userId: 1 })));

  assert.equal(results.filter((r) => r === 'released').length, 1);
  assert.equal(await getStock(eventId), 10);
});

test('the stock key format is shared with the Lua scripts', () => {
  // create-hold.lua / release-hold.lua build 'event:' .. id .. ':stock' themselves.
  assert.equal(stockKey(123), 'event:123:stock');
});
