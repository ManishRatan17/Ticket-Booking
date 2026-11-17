// Ticket stock for general-admission events, kept in Redis.
// Redis key per event:  event:<id>:stock  ->  number of tickets still available
import { readFileSync } from 'node:fs';
import { redis } from '../../config/redis.js';

export function stockKey(eventId) {
  return `event:${eventId}:stock`;
}

export async function setStock(eventId, count) {
  await redis.set(stockKey(eventId), count);
}

export async function getStock(eventId) {
  return Number(await redis.get(stockKey(eventId)));
}

// A negative quantity would ADD tickets, so never trust the caller.
function assertValidQuantity(quantity) {
  if (!Number.isInteger(quantity) || quantity < 1) {
    throw new Error(`Invalid quantity: ${quantity}`);
  }
}

// ⚠️ INTENTIONALLY BROKEN — kept for learning (Phase 1, Step 1).
// "Check-then-act": READ the stock, DECIDE in Node, then WRITE the new value.
// Between the read and the write, other requests can read the same old value,
// so many buyers all see "100 left" and all succeed. Never use this for real holds.
export async function holdTicketsNaive(eventId, quantity) {
  const stock = await getStock(eventId);              // 1. CHECK (read)
  if (stock < quantity) return false;                  // 2. decide
  await redis.set(stockKey(eventId), stock - quantity); // 3. ACT (write)
  return true;
}

// ✅ Fix #1 — "act first, check after" with atomic DECRBY / INCRBY.
// DECRBY subtracts and returns the new value in ONE Redis command, so no two
// buyers can get the same result. If we went below zero, we undo with INCRBY.
// Correct (never oversells), but has two weaknesses — see the Step 2 explanation:
//   1. while the stock is briefly negative, other buyers can be wrongly refused;
//   2. if the server crashes between DECRBY and INCRBY, those tickets are lost.
export async function holdTicketsDecr(eventId, quantity) {
  assertValidQuantity(quantity);
  const remaining = await redis.decrby(stockKey(eventId), quantity);
  if (remaining < 0) {
    await redis.incrby(stockKey(eventId), quantity); // give them back
    return false;
  }
  return true;
}

// ✅ Fix #2 (the one we'll use) — a Lua script that checks AND subtracts as one step.
// defineCommand loads the script once; Redis caches it and we call it by its hash (EVALSHA).
redis.defineCommand('holdStock', {
  numberOfKeys: 1,
  lua: readFileSync(new URL('./lua/hold-stock.lua', import.meta.url), 'utf8'),
});

export async function holdTickets(eventId, quantity) {
  assertValidQuantity(quantity);
  const result = await redis.holdStock(stockKey(eventId), quantity);
  if (result === -1) throw new Error(`No stock set up for event ${eventId}`);
  return result === 1;
}
