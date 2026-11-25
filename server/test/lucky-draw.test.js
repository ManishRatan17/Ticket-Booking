// The lucky draw, part 2: who wins, round by round, provably fair. Requires Docker.
// (The draw's separate ticket pool is tested in lucky-draw-pool.test.js.)
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { createApp } from '../src/app.js';
import { pool } from '../src/config/db.js';
import { redis } from '../src/config/redis.js';
import { runMigrations } from '../src/db/migrate.js';
import { closeConnections } from '../src/config/connections.js';
import { createEvent } from '../src/modules/events/events.service.js';
import { stockKey, lotteryStockKey, lotteryClosedKey } from '../src/modules/reservation/stock.js';
import { roomKeysPattern, ACTIVE_ROOMS } from '../src/modules/waiting-room/waiting-room.js';
import { runLotteryTick, ROUNDS } from '../src/modules/lottery/lottery.service.js';
import { drawNumber, hashSeed, makeSeed } from '../src/modules/lottery/lottery.js';
import { createSignedInUsers } from '../test-support/users.js';
import { deleteEventKeys } from '../test-support/redis-cleanup.js';

const RUN = `test-ldraw-${randomUUID().slice(0, 8)}`;
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
  if (createdEventIds.length) {
    await pool.query('DELETE FROM sold_tickets WHERE event_id = ANY($1)', [createdEventIds]);
    await pool.query('DELETE FROM orders WHERE event_id = ANY($1)', [createdEventIds]);
    await pool.query('DELETE FROM events WHERE id = ANY($1)', [createdEventIds]); // draws, entries, winners cascade
  }
  await pool.query('DELETE FROM users WHERE email LIKE $1', [`${RUN}%`]);
  server.close();
  await closeConnections();
});

// 20 tickets, 50 % in the draw → 10 lucky-draw tickets, 2 per winner → 5 winners in round 1.
// The sale opened 2 minutes ago and the draw is 1 minute after it: the draw is due.
async function event({ drawMinutes = 1, saleAgoMs = 120_000, tickets = 20, perWinner = 2 } = {}) {
  const e = await createEvent({
    name: `${RUN} event ${++n}`,
    totalTickets: tickets,
    saleStartsAt: new Date(Date.now() - saleAgoMs),
    admissionPerSecond: 1,
    lotteryPercent: 50,
    lotteryDrawMinutes: drawMinutes,
    lotteryPerWinner: perWinner,
  });
  createdEventIds.push(e.id);
  return e;
}
const users = (count) => createSignedInUsers(count, { prefix: `${RUN}-${++n}` });

async function api(method, path, { as, body } = {}) {
  const headers = {};
  if (as) headers.Cookie = as.cookie;
  if (body) headers['Content-Type'] = 'application/json';
  const res = await fetch(`${baseUrl}${path}`, { method, headers, body: body && JSON.stringify(body) });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}
const join = (u, e) => api('POST', `/api/events/${e.id}/queue`, { as: u });
const draw = async (u, e) => (await api('GET', `/api/events/${e.id}/queue`, { as: u })).body.lottery;
const hold = (u, e, quantity) => api('POST', `/api/events/${e.id}/holds`, { as: u, body: { quantity } });
const tick = (e) => runLotteryTick({ eventIds: [e.id] });
// A round lasts 10 minutes: pretend they've passed.
const roundPasses = (e) =>
  pool.query("UPDATE lottery_draws SET last_round_at = last_round_at - interval '601 seconds' WHERE event_id = $1", [e.id]);
const winnerIds = async (e) =>
  (await pool.query('SELECT user_id FROM lottery_winners WHERE event_id = $1 ORDER BY user_id', [e.id])).rows.map((r) => Number(r.user_id));
const seedOf = async (e) => (await pool.query('SELECT seed FROM lottery_draws WHERE event_id = $1', [e.id])).rows[0].seed;
// Who SHOULD win, from the seed alone: the lowest draw numbers.
const lowestNumbers = (seed, e, people, count) =>
  [...people]
    .sort((a, b) => (drawNumber(seed, e.id, a.id) < drawNumber(seed, e.id, b.id) ? -1 : 1))
    .slice(0, count)
    .map((u) => u.id);

// ---------- the commit, before the draw ----------

test('before the draw: the fingerprint is public, the seed is secret; joining the waiting room = entered', async () => {
  const e = await event({ drawMinutes: 30, saleAgoMs: 60_000 }); // the draw is in 29 minutes
  const [ann, bob] = await users(2);
  assert.equal((await join(ann, e)).status, 200);

  const mine = await draw(ann, e);
  assert.equal(mine.state, 'upcoming');
  assert.match(mine.seedHash, /^[0-9a-f]{64}$/);
  assert.equal(mine.seed, null, 'the seed stays secret until the draw');
  assert.deepEqual([mine.entered, mine.entrants, mine.tickets, mine.perWinner], [true, 1, 10, 2]);
  assert.equal(mine.odds, 1, '5 possible winners, 1 person entered');
  assert.equal((await draw(bob, e)).entered, false, 'not entered without joining');

  assert.deepEqual(await tick(e), { winners: 0, closed: 0 }, 'not due yet: nothing happens');
});

// ---------- round 1 ----------

test('round 1: 12 entered, 10 tickets ÷ 2 → exactly the 5 LOWEST draw numbers win; anyone can verify it', async () => {
  const e = await event();
  const crowd = await users(12);
  for (const u of crowd) await join(u, e);

  assert.deepEqual(await tick(e), { winners: 5, closed: 0 });
  const seed = await seedOf(e);
  assert.deepEqual(await winnerIds(e), lowestNumbers(seed, e, crowd, 5).sort((a, b) => a - b));

  // What a person's page shows after the draw lets them check it themselves.
  const view = await draw(crowd[0], e);
  assert.equal(view.state, 'drawing');
  assert.equal(view.seed, seed, 'revealed');
  assert.equal(createHash('sha256').update(view.seed).digest('hex'), view.seedHash, 'it matches the fingerprint published before');
  assert.equal(view.myDrawNumber, drawNumber(seed, e.id, crowd[0].id));
  assert.equal(view.entrants, 12);
});

test('round 1: winners get a lucky pass (10 minutes) and can hold lucky-draw tickets; others can\'t', async () => {
  const e = await event();
  const crowd = await users(8);
  for (const u of crowd) await join(u, e);
  await tick(e);
  const won = new Set(await winnerIds(e));
  const winner = crowd.find((u) => won.has(u.id));
  const loser = crowd.find((u) => !won.has(u.id));

  const view = await draw(winner, e);
  assert.equal(view.won.round, 1);
  assert.ok(view.won.passExpiresInSeconds > 590 && view.won.passExpiresInSeconds <= 600);
  const h = await hold(winner, e, 2);
  assert.equal(h.status, 201);
  assert.equal(h.body.hold.pool, 'lottery');

  assert.equal((await draw(loser, e)).won, null);
  assert.notEqual((await hold(loser, e, 1)).body.hold?.pool, 'lottery', 'a non-winner never gets lucky-draw tickets');
});

test('two draw jobs at the same moment never run a round twice', async () => {
  const e = await event();
  const crowd = await users(12);
  for (const u of crowd) await join(u, e);
  const [a, b] = await Promise.all([tick(e), tick(e)]);
  assert.equal(a.winners + b.winners, 5);
  assert.equal((await pool.query('SELECT rounds_done FROM lottery_draws WHERE event_id = $1', [e.id])).rows[0].rounds_done, 1);
});

// ---------- later rounds ----------

test('round 2 waits a full round; then unclaimed tickets go to the NEXT numbers; nobody wins twice', async () => {
  const e = await event();
  const crowd = await users(12);
  for (const u of crowd) await join(u, e);
  await tick(e);
  const seed = await seedOf(e);
  const round1 = lowestNumbers(seed, e, crowd, 5);

  // Two winners take 2 tickets each: 6 of the 10 are still in the draw.
  for (const id of round1.slice(0, 2)) assert.equal((await hold(crowd.find((u) => u.id === id), e, 2)).status, 201);
  assert.deepEqual(await tick(e), { winners: 0, closed: 0 }, 'round 1 winners still have their 10 minutes');

  await roundPasses(e);
  assert.deepEqual(await tick(e), { winners: 3, closed: 0 }, '6 tickets left ÷ 2 = 3 new winners');
  const all = await winnerIds(e);
  assert.equal(all.length, 8, 'nobody twice (the primary key would refuse it anyway)');
  assert.deepEqual(all, lowestNumbers(seed, e, crowd, 8).sort((a, b) => a - b), 'the next 3 in draw order');
});

test('someone who already bought the 4-ticket maximum is skipped (the next number wins instead)', async () => {
  const e = await event({ perWinner: 2 });
  const crowd = await users(8);
  for (const u of crowd) await join(u, e);
  const seed = await seedOf(e); // (the test may peek; the public only sees it after the draw)
  const [luckiest] = lowestNumbers(seed, e, crowd, 1);
  await pool.query(
    `INSERT INTO orders (user_id, event_id, quantity, status, idempotency_key, expires_at, amount_paise, paid_at)
     VALUES ($1, $2, 4, 'paid', $3, now(), 0, now())`,
    [luckiest, e.id, randomUUID()],
  );

  await tick(e);
  const won = await winnerIds(e);
  assert.ok(!won.includes(luckiest), 'already at the limit: skipped');
  assert.deepEqual(won, lowestNumbers(seed, e, crowd, 6).filter((id) => id !== luckiest).sort((a, b) => a - b));
});

// ---------- closing ----------

test(`after ${ROUNDS} rounds and one more round of time: the draw closes, leftovers go back to the normal sale`, async () => {
  const e = await event(); // 10 normal + 10 lucky-draw tickets
  const crowd = await users(3); // only 3 people: 3 winners, nobody else to draw
  for (const u of crowd) await join(u, e);
  await tick(e); // round 1: 3 winners
  const winner = crowd[0];
  const h = (await hold(winner, e, 2)).body.hold; // one of them holds 2
  await roundPasses(e);
  await tick(e); // round 2: nobody left to win
  await roundPasses(e);
  await tick(e); // round 3
  await roundPasses(e);
  assert.deepEqual(await tick(e), { winners: 0, closed: 1 });

  assert.deepEqual((await redis.mget(stockKey(e.id), lotteryStockKey(e.id))).map(Number), [18, 0], '10 + the 8 left over');
  assert.equal(await redis.exists(lotteryClosedKey(e.id)), 1);
  assert.ok((await pool.query('SELECT lottery_closed_at FROM events WHERE id = $1', [e.id])).rows[0].lottery_closed_at);
  assert.equal((await draw(winner, e)).state, 'closed');

  // The winner lets their 2 go AFTER the close: they go to the normal sale too.
  assert.equal((await api('DELETE', `/api/holds/${h.id}`, { as: winner })).status, 204);
  assert.equal(Number(await redis.get(stockKey(e.id))), 20);
  assert.deepEqual(await tick(e), { winners: 0, closed: 0 }, 'a closed draw is left alone');
});

test('a draw nobody entered: no winners, and at closing all its tickets go to the normal sale', async () => {
  const e = await event();
  for (let round = 1; round <= ROUNDS; round++) {
    assert.equal((await tick(e)).winners, 0);
    await roundPasses(e);
  }
  assert.equal((await tick(e)).closed, 1);
  assert.deepEqual((await redis.mget(stockKey(e.id), lotteryStockKey(e.id))).map(Number), [20, 0]);
});

// ---------- fairness of the numbers themselves ----------

test('commit–reveal helpers: a seed is 32 random bytes; its fingerprint is SHA-256', () => {
  const seed = makeSeed();
  assert.match(seed, /^[0-9a-f]{64}$/);
  assert.notEqual(makeSeed(), seed);
  assert.equal(hashSeed(seed), createHash('sha256').update(seed).digest('hex'));
});

test('fair: over 2,000 seeds, each of 10 entrants has the lowest number about equally often', () => {
  const wins = new Array(10).fill(0);
  for (let i = 0; i < 2000; i++) {
    const seed = makeSeed();
    let best = 0;
    for (let u = 1; u < 10; u++) if (drawNumber(seed, 7, u + 1) < drawNumber(seed, 7, best + 1)) best = u;
    wins[best] += 1;
  }
  // Expected 200 each. Chi-square with 9 degrees of freedom: above 27.9 happens < 0.1 % of the time.
  const chi2 = wins.reduce((sum, w) => sum + (w - 200) ** 2 / 200, 0);
  assert.ok(chi2 < 27.9, `wins ${wins.join(', ')} (chi² = ${chi2.toFixed(1)})`);
});

// ---------- live: the win arrives on the open stream ----------

test('live: someone already let in by the line, still in the draw, keeps the stream — and sees "won" arrive', async () => {
  const { admitWaiting } = await import('../src/jobs/processors.js');
  const e = await event({ perWinner: 2 });
  const [ann] = await users(1);
  await join(ann, e);
  await admitWaiting({ eventIds: [e.id] }); // the line lets her in

  const res = await fetch(`${baseUrl}/api/events/${e.id}/queue/stream`, { headers: { Cookie: ann.cookie } });
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  async function next() {
    const deadline = Date.now() + 5000;
    for (;;) {
      const end = buffer.indexOf('\n\n');
      if (end >= 0) {
        const block = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        const data = block.split('\n').find((l) => l.startsWith('data:'));
        if (data) return JSON.parse(data.slice(5));
        continue;
      }
      if (Date.now() > deadline) throw new Error('no message in time');
      const { value, done } = await reader.read();
      if (done) return null;
      buffer += decoder.decode(value, { stream: true });
    }
  }

  const first = await next();
  assert.equal(first.status, 'admitted');
  assert.equal(first.lottery.won, null);
  await tick(e); // the draw: she's the only entrant, so she wins
  const later = await next();
  assert.ok(later, 'the stream stayed open (she was waiting for the draw)');
  assert.equal(later.lottery.won.round, 1);
  await reader.cancel();
});
