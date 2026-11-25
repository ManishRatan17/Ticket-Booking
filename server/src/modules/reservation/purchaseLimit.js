// A person's purchase limit for one event (Phase 5b): normally MAX_TICKETS_PER_USER (4).
// An admin can raise it for one person and one event by approving a "more tickets" support
// request (purchase_limit_overrides, migration 009): limit = 4 + extra, at most 8.
//
// Read from PostgreSQL every time (one primary-key lookup): the hold's Lua script and the
// payment transaction both get the same number, and an approval takes effect immediately.
import { pool } from '../../config/db.js';
import { MAX_TICKETS_PER_USER } from './holds.js';

export async function purchaseLimitFor(eventId, userId, client = pool) {
  const { rows } = await client.query('SELECT extra FROM purchase_limit_overrides WHERE event_id = $1 AND user_id = $2', [
    eventId,
    userId,
  ]);
  return MAX_TICKETS_PER_USER + (rows[0]?.extra ?? 0);
}
