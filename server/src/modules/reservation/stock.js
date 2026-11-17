// Ticket stock for general-admission events, kept in Redis.
// Redis key per event:  event:<id>:stock  ->  number of tickets still available
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
