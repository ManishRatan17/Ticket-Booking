// THE most important tests in the project: many buyers, one stock counter, zero oversells.
// Requires `docker compose up -d`.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import {
  setStock,
  getStock,
  holdTickets,
  holdTicketsNaive,
  stockKey,
} from '../src/modules/reservation/stock.js';
import { redis } from '../src/config/redis.js';
import { closeConnections } from '../src/config/connections.js';

// Every test uses its own random event id, so tests never share a counter
// (and never touch real event keys). All are deleted at the end.
const usedEvents = [];
function newEventId() {
  const id = `test-${randomUUID()}`;
  usedEvents.push(id);
  return id;
}

after(async () => {
  await redis.del(...usedEvents.map(stockKey));
  await closeConnections();
});

// Fires all buyers at once (no awaiting in between) and returns each one's result.
function rush(eventId, quantities, holdFn = holdTickets) {
  return Promise.all(quantities.map((q) => holdFn(eventId, q)));
}

test('1,000 concurrent buyers for 100 tickets: exactly 100 win, stock ends at 0', async () => {
  // Repeat a few times: a race condition may hide in one run and show in the next.
  for (let round = 1; round <= 5; round++) {
    const eventId = newEventId();
    await setStock(eventId, 100);

    const results = await rush(eventId, Array(1000).fill(1));

    assert.equal(results.filter(Boolean).length, 100, `round ${round}: winners`);
    assert.equal(await getStock(eventId), 0, `round ${round}: stock left`);
  }
});

test('mixed quantities: tickets are conserved and nobody is wrongly refused', async () => {
  const eventId = newEventId();
  const TOTAL = 100;
  await setStock(eventId, TOTAL);

  // 500 buyers each asking for 1 to 4 tickets.
  const quantities = Array.from({ length: 500 }, () => 1 + Math.floor(Math.random() * 4));
  const results = await rush(eventId, quantities);
  const left = await getStock(eventId);

  // 1. Conservation: tickets handed out + tickets left = what we started with.
  const handedOut = quantities.reduce((sum, q, i) => (results[i] ? sum + q : sum), 0);
  assert.equal(handedOut + left, TOTAL, 'tickets were created or destroyed');

  // 2. Never negative.
  assert.ok(left >= 0, `stock went negative: ${left}`);

  // 3. No false "sold out": stock only goes down, so if a buyer was refused,
  //    their quantity must be bigger than what is left at the end.
  quantities.forEach((q, i) => {
    if (!results[i]) assert.ok(q > left, `buyer ${i} wanted ${q} but ${left} were left`);
  });
});

test('sold out: a buyer is refused and the stock is unchanged', async () => {
  const eventId = newEventId();
  await setStock(eventId, 2);

  assert.equal(await holdTickets(eventId, 3), false);
  assert.equal(await getStock(eventId), 2);
});

test('invalid quantities are rejected before touching Redis', async () => {
  const eventId = newEventId();
  await setStock(eventId, 10);

  for (const bad of [0, -5, 1.5, '2', NaN, null]) {
    await assert.rejects(holdTickets(eventId, bad), /Invalid quantity/, `accepted ${bad}`);
  }
  assert.equal(await getStock(eventId), 10, 'stock changed after invalid requests');
});

test('an event with no stock set up throws instead of saying "sold out"', async () => {
  await assert.rejects(holdTickets(newEventId(), 1), /No stock set up/);
});

// Proves the test above is actually able to catch a race condition:
// the same scenario against the intentionally broken version MUST oversell.
test('sanity check: the naive version oversells under the same load', async () => {
  const eventId = newEventId();
  await setStock(eventId, 100);

  const results = await rush(eventId, Array(1000).fill(1), holdTicketsNaive);

  assert.ok(results.filter(Boolean).length > 100, 'naive version did not oversell');
});
