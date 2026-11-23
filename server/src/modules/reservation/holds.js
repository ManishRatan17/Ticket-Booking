// Ticket holds: "user 42 holds 2 tickets for event 7 until 12:05".
// Built on the atomic stock counter from Phase 1 (stock.js), now with an owner and an expiry.
//
// Redis keys (the Lua scripts build some of these names too — keep them in sync):
//   event:<eventId>:stock                 tickets available        (stock.js)
//   hold:<holdId>                         { userId, eventId, quantity, createdAt, expiresAt }
//   event:<eventId>:user:<userId>:hold    the user's hold id for that event
//
// Why holds are NOT deleted by a Redis TTL: Redis would delete the record, and its tickets
// would never return to stock (nothing would remember how many to give back). Expired holds
// are released explicitly: lazily when the same user holds again (create-hold.lua), and by
// the expiry worker in Phase 3. Until then, OTHER users' expired holds keep their tickets.
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { redis } from '../../config/redis.js';
import { env } from '../../config/env.js';
import { stockKey } from './stock.js';

export const HOLD_SECONDS = env.holds.seconds; // 5 minutes unless HOLD_SECONDS says otherwise
export const MAX_TICKETS_PER_HOLD = 4;

// An index of every hold by its expiry time (Redis SORTED SET: member = hold id,
// score = expiresAt in ms). Kept up to date by the Lua scripts themselves, atomically.
// "Which holds expired before now?" is then one fast query: ZRANGEBYSCORE … -inf now.
export const HOLDS_BY_EXPIRY = 'holds:by-expiry';

const holdKey = (holdId) => `hold:${holdId}`;
const userHoldKey = (eventId, userId) => `event:${eventId}:user:${userId}:hold`;
const lua = (file) => readFileSync(new URL(`./lua/${file}`, import.meta.url), 'utf8');

redis.defineCommand('createHold', { numberOfKeys: 3, lua: lua('create-hold.lua') });
redis.defineCommand('releaseHold', { numberOfKeys: 1, lua: lua('release-hold.lua') });
redis.defineCommand('consumeHold', { numberOfKeys: 1, lua: lua('consume-hold.lua') });

// A thrown error = a BUG in the caller (bad input, stock never loaded). Business outcomes
// like "sold out" are RETURNED, because they're normal.
function assertValid({ eventId, userId, quantity }) {
  if (!Number.isInteger(quantity) || quantity < 1 || quantity > MAX_TICKETS_PER_HOLD) {
    throw new Error(`Invalid quantity: ${quantity}`);
  }
  if (!Number.isSafeInteger(userId) || userId < 1) throw new Error(`Invalid userId: ${userId}`);
  if (eventId === undefined || eventId === null || String(eventId).includes(':')) {
    throw new Error(`Invalid eventId: ${eventId}`); // ':' would break the key layout
  }
}

// Returns one of:
//   { status: 'held', hold }
//   { status: 'already_holding', holdId }
//   { status: 'sold_out', available }
export async function createHold({ eventId, userId, quantity }) {
  assertValid({ eventId, userId, quantity });
  const holdId = randomUUID();
  const [code, value] = await redis.createHold(
    stockKey(eventId),
    userHoldKey(eventId, userId),
    holdKey(holdId),
    holdId,
    userId,
    eventId,
    quantity,
    HOLD_SECONDS,
  );

  switch (code) {
    case 1:
      return {
        status: 'held',
        hold: { id: holdId, eventId: String(eventId), userId, quantity, expiresAt: new Date(Number(value)) },
      };
    case 0:
      return { status: 'sold_out', available: Number(value) };
    case -2:
      return { status: 'already_holding', holdId: value };
    default:
      throw new Error(`No stock set up for event ${eventId}`);
  }
}

// "Now" according to REDIS — the same clock create-hold.lua uses for expiresAt.
// Sent to the browser as serverTime, so a countdown never depends on the user's own clock.
export async function redisNow() {
  const [seconds, microseconds] = await redis.time();
  return new Date(Number(seconds) * 1000 + Math.floor(Number(microseconds) / 1000));
}

function toHold(holdId, fields) {
  if (!fields.quantity) return null;
  const expiresAt = new Date(Number(fields.expiresAt));
  return {
    id: holdId,
    eventId: fields.eventId,
    userId: Number(fields.userId),
    quantity: Number(fields.quantity),
    createdAt: new Date(Number(fields.createdAt)),
    expiresAt,
    expired: expiresAt.getTime() <= Date.now(),
  };
}

export async function getHold(holdId) {
  return toHold(holdId, await redis.hgetall(holdKey(holdId)));
}

// The user's hold for an event, or null. An expired one is still returned (expired: true)
// until it's released — the caller decides what to show.
export async function getUserHold(eventId, userId) {
  const holdId = await redis.get(userHoldKey(eventId, userId));
  return holdId ? getHold(holdId) : null;
}

// Ids of holds whose time ran out (by Redis's clock), oldest first, at most `limit`.
export async function expiredHoldIds(limit = 500) {
  const now = await redisNow();
  return redis.zrangebyscore(HOLDS_BY_EXPIRY, '-inf', now.getTime(), 'LIMIT', 0, limit);
}

export async function removeFromExpiryIndex(holdId) {
  await redis.zrem(HOLDS_BY_EXPIRY, holdId);
}

// Puts every existing hold into the index (ZADD NX: entries already there are left alone).
// For holds made before the index existed, or after the index was lost. Run by the worker at startup.
export async function indexAllHolds() {
  let added = 0;
  for await (const keys of redis.scanStream({ match: 'hold:*', count: 500 })) {
    for (const key of keys) {
      const expiresAt = await redis.hget(key, 'expiresAt');
      if (expiresAt) added += await redis.zadd(HOLDS_BY_EXPIRY, 'NX', expiresAt, key.slice('hold:'.length));
    }
  }
  return added;
}

// The hold was PAID for: delete it and keep its tickets out of stock (they're sold now).
// Returns true if the hold still existed, false if it was already gone (released after
// expiring, or consumed by an earlier delivery of the same payment).
export async function consumeHold(holdId) {
  return (await redis.consumeHold(holdKey(holdId), holdId)) === 1;
}

// Returns 'released' | 'not_found' | 'not_owner'.
// Pass userId to release as that user (only their own hold); omit it for the system.
export async function releaseHold(holdId, { userId } = {}) {
  const result = await redis.releaseHold(holdKey(holdId), holdId, userId === undefined ? '' : String(userId));
  return result === 1 ? 'released' : result === -1 ? 'not_owner' : 'not_found';
}
