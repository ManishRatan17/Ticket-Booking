// The waiting room's "what are my chances?" estimate (pure function, no database).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { estimateChance, ASSUMED_TICKETS_PER_BUYER } from '../src/modules/waiting-room/chance.js';

const waiting = (position, ticketsLeft) => estimateChance({ status: 'waiting', position, total: 5000, ticketsLeft }).chance;
const lobby = (total, ticketsLeft) => estimateChance({ status: 'lobby', total, ticketsLeft }).chance;

test('buyers left = tickets left ÷ 2, rounded up', () => {
  assert.equal(ASSUMED_TICKETS_PER_BUYER, 2);
  assert.equal(estimateChance({ status: 'waiting', position: 1, total: 1, ticketsLeft: 1000 }).buyersLeft, 500);
  assert.equal(estimateChance({ status: 'waiting', position: 1, total: 1, ticketsLeft: 3 }).buyersLeft, 2);
  // A negative stock (never expected) is treated as none left.
  assert.deepEqual(estimateChance({ status: 'waiting', position: 1, total: 1, ticketsLeft: -2 }), {
    chance: 'all_held',
    ticketsLeft: 0,
    buyersLeft: 0,
  });
});

test('in line, 1,000 tickets (~500 buyers): #341 good, #601 maybe, #1,500 unlikely', () => {
  assert.equal(waiting(341, 1000), 'good');
  assert.equal(waiting(601, 1000), 'maybe');
  assert.equal(waiting(1500, 1000), 'unlikely');
});

test('in line: the exact boundaries (0.7 and 1.3 × buyers left)', () => {
  // 500 buyers: good while fewer than 350 are ahead; maybe while fewer than 650 are ahead.
  assert.equal(waiting(350, 1000), 'good'); // 349 ahead
  assert.equal(waiting(351, 1000), 'maybe'); // 350 ahead
  assert.equal(waiting(650, 1000), 'maybe'); // 649 ahead
  assert.equal(waiting(651, 1000), 'unlikely'); // 650 ahead
});

test('in line: first in line with tickets left → good', () => {
  assert.equal(waiting(1, 1), 'good');
});

test('none left right now → all_held for everyone; every ticket PAID → sold_out (not estimates)', () => {
  for (const status of ['waiting', 'lobby', 'not_in_queue', 'admitted']) {
    assert.equal(estimateChance({ status, position: 1, total: 3, ticketsLeft: 0 }).chance, 'all_held', status);
    assert.deepEqual(estimateChance({ status, position: 1, total: 3, ticketsLeft: 5, soldOutForGood: true }), {
      chance: 'sold_out',
      ticketsLeft: 0,
      buyersLeft: 0,
    });
  }
});

test('in the lobby everyone has the same chance: buyers left ÷ people in the lobby', () => {
  assert.equal(lobby(600, 1000), 'good'); // 500 / 600 = 0.83
  assert.equal(lobby(1000, 1000), 'maybe'); // 0.5
  assert.equal(lobby(1800, 1000), 'unlikely'); // 0.28
  assert.equal(lobby(100, 1000), 'good'); // plenty for everyone
});

test('not in line, or already admitted → no estimate (but tickets left are still reported)', () => {
  assert.deepEqual(estimateChance({ status: 'not_in_queue', ticketsLeft: 10 }), { chance: null, ticketsLeft: 10, buyersLeft: 5 });
  assert.equal(estimateChance({ status: 'admitted', ticketsLeft: 10 }).chance, null);
});
