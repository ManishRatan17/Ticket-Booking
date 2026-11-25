// The PRODUCER side of background jobs (BullMQ).
//
// A job is a small message — "expire hold 3f2a…" — stored in Redis. A WORKER process picks it
// up and does the work. Delayed jobs wait in Redis until their time comes.
//
//   API process  ──add job──►  Redis (queue "expirations")  ──take job──►  worker process
//    (producer)                                                         (consumer)
import { Queue } from 'bullmq';
import { Redis } from 'ioredis';
import { env } from '../config/env.js';
import { redisNow } from '../modules/reservation/holds.js';

export const QUEUE_NAME = 'expirations';

// BullMQ needs its OWN Redis connection with maxRetriesPerRequest: null — "keep waiting for
// Redis, never give up on a command". A worker blocks while waiting for jobs; failing fast
// (what the API's connection does on purpose, see config/redis.js) would break that.
export function createJobsConnection() {
  return new Redis(env.redisUrl, { maxRetriesPerRequest: null });
}

// Every job gets these unless it says otherwise.
export const DEFAULT_JOB_OPTIONS = {
  attempts: 5, // a failing job is retried up to 5 times…
  backoff: { type: 'exponential', delay: 1000 }, // …waiting 1 s, 2 s, 4 s, 8 s in between
  removeOnComplete: 1000, // keep the last 1,000 finished jobs (for the admin page), forget older ones
  removeOnFail: false, // NEVER auto-delete a job that failed every attempt: that's the
  //                      dead-letter queue — a human looks at it (admin page) and can retry it
};

let queue;
export function getQueue() {
  queue ??= new Queue(QUEUE_NAME, {
    connection: createJobsConnection(),
    prefix: env.jobs.prefix,
    defaultJobOptions: DEFAULT_JOB_OPTIONS,
  });
  return queue;
}

// Called right after a hold is created: "at expiresAt, expire this hold".
// The delay is measured with REDIS's clock (the clock that set expiresAt), not this machine's.
// The jobId makes scheduling idempotent: adding the same hold twice keeps ONE job.
export async function scheduleHoldExpiry(hold) {
  if (!env.jobs.enabled) return;
  const now = await redisNow();
  await getQueue().add(
    'expire-hold',
    { holdId: hold.id },
    {
      jobId: `expire-hold-${hold.id}`,
      delay: Math.max(0, new Date(hold.expiresAt).getTime() - now.getTime()) + 500, // + a little margin
    },
  );
}

// An email, delivered by the worker (lib/mailer.js). Retried with growing pauses if the provider is
// down. removeOnComplete: true — emails can hold one-time links (password reset), so a delivered one
// isn't kept in Redis. One that fails every attempt stays in the dead-letter queue (System page).
export async function queueEmail(message) {
  await getQueue().add('send-email', message, { removeOnComplete: true });
}

export const SWEEP_EVERY_MS = 60_000;

// The safety-net sweep runs every 60 s. A job SCHEDULER (stored in Redis) creates the jobs, so
// it keeps going across restarts; "upsert" means calling this again changes nothing — so every
// worker can call it at startup, and there's still only ONE schedule.
export async function scheduleSweep() {
  await getQueue().upsertJobScheduler('sweep-expired', { every: SWEEP_EVERY_MS }, { name: 'sweep-expired', data: {} });
}

// The admission worker lets people out of waiting rooms every second (Phase 4). Same idea as
// the sweep: one schedule in Redis, safe for every worker to set up at startup.
export const ADMIT_EVERY_MS = 1000;
export async function scheduleAdmissions() {
  await getQueue().upsertJobScheduler('admit-waiting', { every: ADMIT_EVERY_MS }, { name: 'admit-waiting', data: {} });
}

// Lucky draws are moved forward every few seconds (a round lasts minutes, so 5 s is precise enough).
export const LOTTERY_EVERY_MS = 5000;
export async function scheduleLottery() {
  await getQueue().upsertJobScheduler('lottery-tick', { every: LOTTERY_EVERY_MS }, { name: 'lottery-tick', data: {} });
}

export async function closeQueue() {
  if (queue) {
    await queue.close();
    await queue.opts.connection.quit?.();
    queue = undefined;
  }
}
