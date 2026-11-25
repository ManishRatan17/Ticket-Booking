// A person's purchase limit for one event (Phase 5b): normally MAX_TICKETS_PER_USER (4).
// An admin can raise it for one person and one event by approving a "more tickets" support
// request (purchase_limit_overrides, migration 009): limit = 4 + extra, at most 8.
//
// Read from PostgreSQL (one primary-key lookup). The payment transaction always reads it fresh; the
// hold path reuses it for up to 1 s (Phase 6 load test), and an approval clears it on this server.
import { pool } from '../../config/db.js';
import { env } from '../../config/env.js';
import { createShortCache } from '../../lib/shortCache.js';
import { MAX_TICKETS_PER_USER } from './holds.js';

// The hold path (every click) reads it through a 1-second cache; the PAYMENT transaction passes its
// own client and always reads the database (the final check must be exact).
const cache = createShortCache({ ttlMs: env.hotCacheMs });
export const forgetPurchaseLimit = (eventId, userId) => cache.delete(`${eventId}:${userId}`);

export async function purchaseLimitFor(eventId, userId, client = null) {
  if (client) return readLimit(client, eventId, userId);
  return cache.get(`${eventId}:${userId}`, () => readLimit(pool, eventId, userId));
}

async function readLimit(client, eventId, userId) {
  const { rows } = await client.query('SELECT extra FROM purchase_limit_overrides WHERE event_id = $1 AND user_id = $2', [
    eventId,
    userId,
  ]);
  return MAX_TICKETS_PER_USER + (rows[0]?.extra ?? 0);
}
