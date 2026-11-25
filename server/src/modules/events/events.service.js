// Events and ticket holds: the rules. No HTTP in here.
import { redis } from '../../config/redis.js';
import { withTransaction } from '../../config/db.js';
import { createDraw } from '../lottery/lottery.repository.js';
import { hashSeed, makeSeed } from '../lottery/lottery.js';
import { AppError } from '../../lib/errors.js';
import { stockKey, lotteryStockKey } from '../reservation/stock.js';
import {
  createHold,
  getBought,
  getUserHold,
  quickLook,
  releaseHold,
  redisNow,
  setBoughtIfMissing,
} from '../reservation/holds.js';
import { paidQuantityForUser } from '../orders/orders.repository.js';
import { purchaseLimitFor } from '../reservation/purchaseLimit.js';
import { pool } from '../../config/db.js';
import * as eventsRepository from './events.repository.js';
import { createShortCache } from '../../lib/shortCache.js';
import { env } from '../../config/env.js';
import { scheduleHoldExpiry } from '../../jobs/queue.js';
import { hasLuckyPass, hasPass } from '../waiting-room/waiting-room.js';

// ---------------------------------------------------------------------------
// Stock: Postgres is the truth, Redis is the fast working copy
// ---------------------------------------------------------------------------

// Makes sure Redis has this event's stock. If the key is missing (new Redis, restart without
// persistence, flushed…), rebuild it from Postgres:  available = total − sold.
//
// SET … NX = "only if it doesn't exist yet", atomically. If 50 requests notice the missing key
// at the same moment, exactly ONE rebuild wins and the others leave it alone — otherwise a late
// rebuild could overwrite stock that holds had already reduced (tickets created out of nothing).
//
// Known limit: holds that lived in Redis are lost with it, so their tickets come back on sale.
// Acceptable for 5-minute holds; PAID tickets are safe because they're counted in Postgres.
//
// With a lucky draw there are TWO pools (each rebuilt the same way):
//   lucky-draw stock = lotteryTickets − sold from the draw          (while the draw is open)
//   normal stock     = total − all sold − what the draw still has
export const lotteryOpen = (event) => event.lotteryTickets > 0 && !event.lotteryClosedAt;

export async function ensureStock(event) {
  const key = stockKey(event.id);
  const lotteryKey = lotteryStockKey(event.id);
  const [current, currentLottery] = await redis.mget(key, lotteryKey);
  const lotteryMissing = lotteryOpen(event) && currentLottery === null;
  if (current !== null && !lotteryMissing) return Number(current);

  const { sold, soldLottery } = await eventsRepository.countSoldTickets(event.id);
  const lotteryLeft = lotteryOpen(event) ? Math.max(0, event.lotteryTickets - soldLottery) : 0;
  if (lotteryMissing) await redis.set(lotteryKey, lotteryLeft, 'NX');
  await redis.set(key, event.totalTickets - sold - lotteryLeft, 'NX');
  return Number(await redis.get(key));
}

// Tickets still in the lucky draw's pool (0 if there's no draw, or it's over).
export async function lotteryStockLeft(event) {
  if (!lotteryOpen(event)) return 0;
  await ensureStock(event);
  return Number((await redis.get(lotteryStockKey(event.id))) ?? 0);
}

// How many tickets this user has bought for this event. Redis answers normally; if it doesn't
// have the count (new Redis, or the user never bought), rebuild it from paid orders.
export async function ensureBought(eventId, userId) {
  const cached = await getBought(eventId, userId);
  if (cached !== null) return cached;
  return setBoughtIfMissing(eventId, userId, await paidQuantityForUser(pool, eventId, userId));
}

async function withAvailability(event, now) {
  return {
    ...event,
    available: await ensureStock(event),
    onSale: new Date(event.saleStartsAt) <= now,
  };
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

export async function createEvent({
  name,
  totalTickets,
  saleStartsAt,
  pricePaise = 0,
  admissionPerSecond = null,
  lobbyMinutes = 15,
  lotteryPercent = 0,
  lotteryDrawMinutes = 30,
  lotteryPerWinner = 2,
}) {
  // The lucky draw's share, rounded down: 20 % of 1,000 = 200; 20 % of 3 = 0 (no draw).
  const lottery = {
    percent: lotteryPercent,
    tickets: Math.floor((totalTickets * lotteryPercent) / 100),
    drawMinutes: lotteryDrawMinutes,
    perWinner: lotteryPerWinner,
  };
  // 1. Postgres first: the event exists for real.
  // The event and its draw (with the secret seed and its public fingerprint) in ONE transaction:
  // an event with a draw but no seed can't exist.
  const event = await withTransaction(async (client) => {
    const created = await eventsRepository.createEvent(
      { name, totalTickets, saleStartsAt, pricePaise, admissionPerSecond, lobbyMinutes, lottery },
      client,
    );
    if (created.lotteryTickets > 0) {
      const seed = makeSeed();
      await createDraw(client, { eventId: created.id, seed, seedHash: hashSeed(seed) });
    }
    return created;
  });
  // 2. Then Redis. If this fails, nothing is lost: ensureStock rebuilds it on first use.
  await ensureStock(event).catch((err) => console.warn(`[events] stock for event ${event.id} not loaded yet: ${err.message}`));
  return withAvailability(event, await redisNow());
}

export async function listEvents() {
  const [events, now] = await Promise.all([eventsRepository.listEvents(), redisNow()]);
  return { events: await Promise.all(events.map((e) => withAvailability(e, now))), serverTime: now };
}

// The event as read by the HOT paths (every hold, every queue status check, every live-stream tick):
// reused for HOT_CACHE_MS (1 s), and 1,000 simultaneous misses share ONE query (shortCache.js).
const eventCache = createShortCache({ ttlMs: env.hotCacheMs });
export const forgetEvent = (eventId) => eventCache.delete(String(eventId));
export async function findEventCached(eventId) {
  return eventCache.get(String(eventId), () => eventsRepository.findEventById(eventId));
}

async function findEventOr404(eventId) {
  const event = await eventsRepository.findEventById(eventId);
  if (!event) throw new AppError(404, 'EVENT_NOT_FOUND', 'No event with this id');
  return event;
}

export async function getEvent(eventId) {
  const [event, now] = await Promise.all([findEventOr404(eventId), redisNow()]);
  return { event: await withAvailability(event, now), serverTime: now };
}

// ---------------------------------------------------------------------------
// Holds
// ---------------------------------------------------------------------------

function toPublicHold(hold) {
  return { id: hold.id, eventId: Number(hold.eventId), quantity: hold.quantity, pool: hold.pool, expiresAt: hold.expiresAt };
}

export async function holdTickets({ eventId, userId, quantity }) {
  const [event, now] = await Promise.all([findEventCached(eventId), redisNow()]);
  if (!event) throw new AppError(404, 'EVENT_NOT_FOUND', 'No event with this id');

  // The SERVER decides when a sale opens. Hiding a button in the browser protects nothing.
  if (new Date(event.saleStartsAt) > now) {
    throw new AppError(409, 'SALE_NOT_STARTED', 'Tickets for this event are not on sale yet', {
      saleStartsAt: event.saleStartsAt,
    });
  }

  // Lucky draw: a WINNER (with a lucky pass) holds from the draw's own pool, up to lotteryPerWinner.
  const lucky = lotteryOpen(event) && (await hasLuckyPass(event.id, userId));
  if (lucky && quantity > event.lotteryPerWinner) {
    throw new AppError(409, 'LUCKY_DRAW_LIMIT', `Lucky-draw winners can buy up to ${event.lotteryPerWinner} tickets`, {
      limit: event.lotteryPerWinner,
    });
  }

  // Waiting room: only people who were let in (who hold a pass) may hold tickets.
  if (!lucky && event.admissionPerSecond && !(await hasPass(event.id, userId))) {
    throw new AppError(403, 'NOT_ADMITTED', 'Join the waiting room first; you can hold tickets once you are let in');
  }
  const pool = lucky ? 'lottery' : 'main';

  // SOLD-OUT FAST PATH (Phase 6 load test): not enough left, and no hold of this person's that the
  // script could release first → answer SOLD_OUT now, from Redis alone, without the per-person
  // lookups below. In a stampede for 300 tickets, ~97 % of clicks end here. (Unknown stock → the
  // normal path, which rebuilds it. The Lua script still decides every real hold.)
  const quick = await quickLook({ eventId: event.id, userId, pool });
  if (quick.available !== null && quick.available < quantity && !quick.hasHold) {
    throw new AppError(409, 'SOLD_OUT', `Not enough tickets left (${quick.available} available)`, { available: quick.available });
  }

  // This person's limit: 4, or more if an admin approved a "more tickets" request (support inbox).
  const [limit] = await Promise.all([purchaseLimitFor(event.id, userId), ensureStock(event), ensureBought(event.id, userId)]);
  let result;
  try {
    result = await createHold({ eventId: event.id, userId, quantity, pool, limit });
  } catch (err) {
    // The stock key vanished between ensureStock and the hold (Redis restarted just then):
    // rebuild once more and retry once.
    if (!/No stock set up/.test(err.message)) throw err;
    await ensureStock(event);
    result = await createHold({ eventId: event.id, userId, quantity, pool, limit });
  }

  switch (result.status) {
    case 'held':
      // PRODUCER: schedule "expire this hold" for when its time runs out (Phase 3).
      // If scheduling fails, the hold still stands — the sweep job (safety net) catches it later.
      await scheduleHoldExpiry(result.hold).catch((err) =>
        console.warn(`[jobs] could not schedule expiry for hold ${result.hold.id}: ${err.message}`),
      );
      return { hold: toPublicHold(result.hold), serverTime: await redisNow() };
    case 'sold_out':
      throw new AppError(409, 'SOLD_OUT', `Not enough tickets left (${result.available} available)`, {
        available: result.available,
      });
    case 'limit_reached':
      throw new AppError(
        409,
        'PURCHASE_LIMIT',
        `You can buy at most ${limit} tickets for this event (you have ${result.bought})`,
        { bought: result.bought, limit },
      );
    default: // 'already_holding'
      throw new AppError(409, 'HOLD_EXISTS', 'You already have tickets on hold for this event', {
        holdId: result.holdId,
      });
  }
}

// Your current hold for an event, or null. If it has expired, it's released right here
// (its tickets go back on sale) — "lazy expiry" again, this time when someone LOOKS at it.
// Also says how many you've bought and the limit, so the page can offer only what's allowed.
export async function getMyHold({ eventId, userId }) {
  const event = await findEventOr404(eventId);
  const [hold, bought, limit] = await Promise.all([
    getUserHold(event.id, userId),
    ensureBought(event.id, userId),
    purchaseLimitFor(event.id, userId),
  ]);
  const purchase = { bought, limit };
  if (hold?.expired) {
    await releaseHold(hold.id);
    return { hold: null, purchase, serverTime: await redisNow() };
  }
  return { hold: hold && toPublicHold(hold), purchase, serverTime: await redisNow() };
}

// 404 for a hold that isn't yours — not 403: never confirm that someone else's hold exists.
export async function releaseMyHold({ holdId, userId }) {
  const result = await releaseHold(holdId, { userId });
  if (result !== 'released') throw new AppError(404, 'HOLD_NOT_FOUND', 'No hold with this id');
}
