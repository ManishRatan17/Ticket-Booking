// What each kind of job DOES. Plain async functions: the worker calls them, and tests can too.
//
// Every job here is IDEMPOTENT — running it twice does no more than running it once — because
// BullMQ guarantees "at least once", not "exactly once": a worker that crashes halfway through
// a job gets the job again after a restart.
import { pool } from '../config/db.js';
import { getHold, releaseHold, redisNow } from '../modules/reservation/holds.js';
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

export const processors = {
  'expire-hold': expireHold,
};
