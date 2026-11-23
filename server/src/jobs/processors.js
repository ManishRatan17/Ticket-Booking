// What each kind of job DOES. Plain async functions: the worker calls them, and tests can too.
//
// Every job here is IDEMPOTENT — running it twice does no more than running it once — because
// BullMQ guarantees "at least once", not "exactly once": a worker that crashes halfway through
// a job gets the job again after a restart.
import { pool } from '../config/db.js';
import {
  getHold,
  releaseHold,
  redisNow,
  expiredHoldIds,
  removeFromExpiryIndex,
} from '../modules/reservation/holds.js';
import * as ordersRepository from '../modules/orders/orders.repository.js';

// "expire-hold": the hold's 5 minutes are over.
export async function expireHold({ holdId }) {
  const hold = await getHold(holdId);
  // Already released (by its owner, lazily, or by an earlier run of this job) or PAID
  // (consumed by the payment webhook): nothing to do.
  if (!hold) return { outcome: 'already_gone' };

  // Decided by REDIS's clock, like every expiry. If the job ran a little early, fail it:
  // BullMQ retries it a moment later (exponential backoff).
  if (hold.expiresAt > (await redisNow())) throw new Error(`hold ${holdId} has not expired yet`);

  // Order first (Postgres), then the hold (Redis): if the payment webhook is processing this
  // order right now, the UPDATE waits for its row lock — and if the payment won, it changes nothing.
  const expiredOrderId = await ordersRepository.expirePendingOrderForHold(pool, holdId);
  const released = await releaseHold(holdId); // system release: tickets back on sale
  return { outcome: released, expiredOrderId };
}

// "sweep-expired": the SAFETY NET, every 60 seconds. Catches what the per-hold jobs missed:
//   • holds that never got a job (made before Phase 3, or scheduling failed while Redis hiccuped)
//   • jobs that were lost (e.g. the queue was wiped)
//   • pending orders past their deadline whose hold is gone (e.g. Redis lost its data)
export async function sweepExpired({ batchSize = 500, maxBatches = 50 } = {}) {
  let holdsReleased = 0;
  let staleEntries = 0;

  // 1. Holds whose time is up, straight from the sorted-set index — batch after batch until
  //    none are left (after a big sale, far more than one batch can expire in a minute).
  //    maxBatches caps one run; the next run, a minute later, continues.
  for (let batch = 0; batch < maxBatches; batch++) {
    const ids = await expiredHoldIds(batchSize);
    let handled = 0;
    for (const holdId of ids) {
      try {
        const result = await expireHold({ holdId });
        if (result.outcome === 'released') holdsReleased++;
        else if (result.outcome === 'already_gone') {
          await removeFromExpiryIndex(holdId); // the hold vanished some other way: drop the stale entry
          staleEntries++;
        }
        handled++;
      } catch (err) {
        console.warn(`[sweep] hold ${holdId}: ${err.message}`); // one bad hold mustn't stop the sweep
      }
    }
    // A short batch means we've reached the end. (handled === 0 guards against a batch of holds
    // that all keep failing: stop instead of looping on them; the next sweep tries again.)
    if (ids.length < batchSize || handled === 0) break;
  }

  // 2. Overdue pending orders in Postgres (5 s of grace so the per-hold job normally goes first).
  const { rows } = await pool.query(
    `UPDATE orders SET status = 'expired', updated_at = now()
      WHERE status = 'pending' AND expires_at < now() - interval '5 seconds'
     RETURNING hold_id`,
  );
  for (const { hold_id: holdId } of rows) if (holdId) await releaseHold(holdId);

  return { holdsReleased, staleEntries, ordersExpired: rows.length };
}

export const processors = {
  'expire-hold': expireHold,
  'sweep-expired': sweepExpired,
};
