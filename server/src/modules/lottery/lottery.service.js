// The lucky draw: rounds, winners, closing — and what a person's page is told about it.
//
//   draw time ──► ROUND 1: freeze the entrants (everyone who joined the waiting room), reveal the
//                 seed, give each its draw number; the lowest numbers win: as many winners as the
//                 draw's tickets allow (tickets left ÷ tickets per winner, rounded up)
//   + 1 round ──► ROUND 2: tickets not taken (or released) → the next numbers in line win
//   + 1 round ──► ROUND 3: the same
//   + 1 round ──► CLOSE: whatever is left goes back to the normal sale
//
// A round lasts ROUND_SECONDS (default 10 minutes): that's how long a winner's lucky pass is valid.
// Each step waits a full round after the previous one, even if the worker was down for a while,
// so every winner always gets their full time.
import { readFileSync } from 'node:fs';
import { pool, withTransaction } from '../../config/db.js';
import { redis } from '../../config/redis.js';
import { env } from '../../config/env.js';
import { lotteryStockKey, lotteryClosedKey, stockKey } from '../reservation/stock.js';
import { MAX_TICKETS_PER_USER } from '../reservation/holds.js';
import { entrantsKey, luckyPassKey } from '../waiting-room/waiting-room.js';
import { lotteryStockLeft } from '../events/events.service.js';
import * as eventsRepository from '../events/events.repository.js';
import * as repo from './lottery.repository.js';
import { drawNumber } from './lottery.js';

export const ROUNDS = 3;
export const ROUND_SECONDS = env.lottery.roundSeconds;

redis.defineCommand('closeLottery', {
  numberOfKeys: 3,
  lua: readFileSync(new URL('./lua/close-lottery.lua', import.meta.url), 'utf8'),
});

// The background job (every few seconds): move every due draw forward by at most one step.
// eventIds: only these events (tests).
export async function runLotteryTick({ eventIds } = {}) {
  const ids = await repo.dueDrawEventIds(pool, eventIds ? eventIds.map(Number) : null);
  let winners = 0;
  let closed = 0;
  for (const id of ids) {
    const result = await advanceDraw(id);
    winners += result.winners;
    if (result.closed) closed += 1;
  }
  return { winners, closed };
}

async function advanceDraw(eventId) {
  const event = await eventsRepository.findEventById(eventId);
  return withTransaction(async (client) => {
    // Locked: two workers running at once can't both run round 2 (the second waits, then sees it done).
    const draw = await repo.lockDraw(client, eventId);
    if (!draw) return { winners: 0 };
    const now = new Date(draw.now);

    // Not yet: the previous round's winners still have their time.
    if (draw.roundsDone > 0 && now - new Date(draw.lastRoundAt) < ROUND_SECONDS * 1000) return { winners: 0 };

    // All rounds done and their time is up: close. Leftovers go back to the normal sale.
    if (draw.roundsDone >= ROUNDS) {
      const moved = await redis.closeLottery(lotteryStockKey(eventId), stockKey(eventId), lotteryClosedKey(eventId));
      await repo.markClosed(client, eventId);
      return { winners: 0, closed: true, moved };
    }

    // Round 1: freeze who's entered, each with their draw number (and the seed becomes public).
    if (draw.roundsDone === 0) {
      const userIds = await redis.smembers(entrantsKey(eventId));
      const entries = userIds.map((id) => ({ userId: Number(id), drawNumber: drawNumber(draw.seed, eventId, id) }));
      await repo.freezeEntrants(client, eventId, entries);
    }

    // As many new winners as the draw's tickets still allow, next in draw order.
    const round = draw.roundsDone + 1;
    const available = await lotteryStockLeft(event);
    let winners = [];
    if (available > 0) {
      winners = await repo.nextWinners(client, {
        eventId,
        count: Math.ceil(available / event.lotteryPerWinner),
        maxPerUser: MAX_TICKETS_PER_USER,
      });
      if (winners.length > 0) {
        await repo.insertWinners(client, { eventId, userIds: winners, round, passSeconds: ROUND_SECONDS });
        // Lucky passes in Redis BEFORE the commit. If the commit then failed, the round isn't recorded
        // and the next tick runs it again — and picks the SAME people (draw numbers are fixed), so
        // nobody is wrongly let in.
        const multi = redis.multi();
        for (const userId of winners) multi.set(luckyPassKey(eventId, userId), '1', 'EX', ROUND_SECONDS);
        await multi.exec();
      }
    }
    await repo.finishRound(client, eventId, round);
    return { winners: winners.length, round };
  });
}

// What one person's page needs to know about an event's draw (null = this event has no draw).
export async function lotteryInfo(event, userId) {
  if (!event.lotteryTickets) return null;
  const row = await repo.drawForUser(pool, event.id, userId);
  if (!row) return null;

  const drawn = Boolean(row.drawn_at);
  const [entrants, entered, passTtl, ticketsLeft] = await Promise.all([
    drawn ? row.entrants : redis.scard(entrantsKey(event.id)),
    drawn ? Boolean(row.draw_number) : redis.sismember(entrantsKey(event.id), String(userId)).then(Boolean),
    redis.ttl(luckyPassKey(event.id, userId)),
    lotteryStockLeft(event),
  ]);
  const possibleWinners = Math.ceil(event.lotteryTickets / event.lotteryPerWinner);

  return {
    state: event.lotteryClosedAt ? 'closed' : drawn ? 'drawing' : 'upcoming',
    tickets: event.lotteryTickets,
    ticketsLeft,
    perWinner: event.lotteryPerWinner,
    drawAt: new Date(new Date(event.saleStartsAt).getTime() + event.lotteryDrawMinutes * 60_000),
    rounds: ROUNDS,
    roundsDone: row.rounds_done,
    entrants,
    entered,
    // Before the draw: everyone has the same chance (≈ winners possible ÷ people entered).
    odds: entrants > 0 ? Math.min(1, possibleWinners / entrants) : null,
    winners: row.winners,
    won: row.won_round ? { round: row.won_round, passExpiresInSeconds: Math.max(0, passTtl) } : null,
    // Provably fair: the fingerprint from the start; the seed and your number once drawn.
    seedHash: row.seed_hash,
    seed: drawn ? row.seed : null,
    myDrawNumber: drawn ? (row.draw_number ?? null) : null,
  };
}
