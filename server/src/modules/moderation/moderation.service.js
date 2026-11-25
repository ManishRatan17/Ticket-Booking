// Moderation: bot signals → suspicion score → strikes → restrictions.
//
//   signal (a refused action, a missing / bad "are you a person?" token)
//        │  points, in Redis, fading after a window (add-signal.lua)
//        ▼
//   score ≥ threshold in the window ──► STRIKE
//        1st strike (in a year) → SUSPENDED: no ticket booking for SUSPENSION_DAYS (default 15)
//        2nd strike (in a year) → BANNED for good
//   The person can still log in: to see why, and to APPEAL (support inbox, kind "appeal").
//
// Only signals tied to an ACCOUNT count, never an IP alone: a whole college shares one IP.
import { readFileSync } from 'node:fs';
import { pool, withTransaction } from '../../config/db.js';
import { redis } from '../../config/redis.js';
import { env } from '../../config/env.js';
import { AppError } from '../../lib/errors.js';
import { releaseHold } from '../reservation/holds.js';
import { removeUserFromWaitingRooms } from '../waiting-room/waiting-room.js';
import * as repo from './moderation.repository.js';
import { createShortCache } from '../../lib/shortCache.js';
import { sendMail } from '../../lib/mailer.js';

const { prefix: PREFIX, threshold: THRESHOLD, windowSeconds: WINDOW_SECONDS, suspensionDays: SUSPENSION_DAYS } = env.moderation;

// "Is this account restricted?" is asked on every booking click: reused for HOT_CACHE_MS (1 s).
// Strikes and lifts on this server forget the old answer at once.
const restrictionCache = createShortCache({ ttlMs: env.hotCacheMs });
export function forgetRestriction(userId) {
  restrictionCache.delete(String(userId));
}

// Every account with a restriction in force is listed in a Redis SET (Phase 6 load test), so "is this
// person restricted?" — asked on EVERY booking click — is one Redis lookup. PostgreSQL stays the truth:
// a listed person is confirmed there (and taken off the list once it's over). If Redis loses the list,
// it's rebuilt from PostgreSQL (the "ready" marker tells us whether the list is complete).
const RESTRICTED = `${PREFIX}:restricted`;
const RESTRICTED_READY = `${PREFIX}:restricted:ready`;

async function rebuildRestrictedList() {
  const { rows } = await pool.query(
    `SELECT DISTINCT user_id FROM account_restrictions WHERE lifted_at IS NULL AND (ends_at IS NULL OR ends_at > now())`,
  );
  const multi = redis.multi().del(RESTRICTED);
  if (rows.length) multi.sadd(RESTRICTED, ...rows.map((r) => String(r.user_id)));
  // The marker expires after an hour, so the list is rebuilt from PostgreSQL at least hourly (that also
  // picks up a restriction written straight into the database).
  await multi.set(RESTRICTED_READY, '1', 'EX', 3600).exec();
}

async function maybeRestricted(userId) {
  const [[, listed], [, ready]] = await redis.multi().sismember(RESTRICTED, String(userId)).exists(RESTRICTED_READY).exec();
  if (ready) return listed === 1;
  await rebuildRestrictedList();
  return (await redis.sismember(RESTRICTED, String(userId))) === 1;
}

// How suspicious each signal is. A person using the site normally never produces any of them;
// a script produces dozens a minute.
export const SIGNAL_POINTS = {
  rate_limited: 1, // an ACTION refused by a per-user rate limit (hold, join, order, pay, release)
  bad_bot_token: 2, // "are you a person?" token rejected by Cloudflare (fake, replayed, or expired)
  missing_bot_token: 5, // no token at all: our page never sends a join without one
};
export const keys = (userId) => ({
  score: `${PREFIX}:score:${userId}`,
  signals: `${PREFIX}:signals:${userId}`,
  flagged: `${PREFIX}:flagged:${userId}`,
});

redis.defineCommand('addBotSignal', {
  numberOfKeys: 3,
  lua: readFileSync(new URL('./lua/add-signal.lua', import.meta.url), 'utf8'),
});

// Record a signal. Never throws (a protection must not break the request that triggered it).
export async function recordSignal(userId, kind) {
  if (!env.moderation.enabled || !userId || !SIGNAL_POINTS[kind]) return null;
  try {
    const k = keys(userId);
    const [score, crossed] = await redis.addBotSignal(k.score, k.signals, k.flagged, SIGNAL_POINTS[kind], kind, WINDOW_SECONDS, THRESHOLD);
    if (crossed !== 1) return { score, strike: null };

    const signals = Object.fromEntries(Object.entries(await redis.hgetall(k.signals)).map(([s, n]) => [s, Number(n)]));
    await redis.del(k.score, k.signals); // the evidence is now kept with the restriction
    const restriction = await strike(userId, {
      reason: 'Automated (bot-like) activity was detected on this account',
      evidence: { score, threshold: THRESHOLD, windowMinutes: Math.round(WINDOW_SECONDS / 60), signals },
    });
    return { score, strike: restriction };
  } catch (err) {
    console.warn(`[moderation] could not record ${kind} for user ${userId}: ${err.message}`);
    return null;
  }
}

// A strike. Automatic (adminId null) or by an admin, who may choose the kind and the days.
// Returns the new restriction, or null if one was already in force (no double punishment).
export async function strike(userId, { reason, evidence = {}, adminId = null, kind = null, days = SUSPENSION_DAYS }) {
  const id = await withTransaction(async (client) => {
    // One person at a time: two strikes racing can't both read "0 earlier strikes".
    if (!(await repo.lockUser(client, userId))) throw new AppError(404, 'USER_NOT_FOUND', 'That user no longer exists');
    if (!kind && (await repo.activeRestriction(client, userId))) return null;
    const earlier = await repo.countStrikes(client, userId);
    const finalKind = kind ?? (earlier > 0 ? 'banned' : 'suspended');
    return repo.insertRestriction(client, { userId, kind: finalKind, reason, evidence, days, createdBy: adminId });
  });
  if (id === null) return null;

  forgetRestriction(userId);
  await redis.sadd(RESTRICTED, String(userId));
  await cleanUpAfterRestriction(userId);
  const restriction = await repo.findRestriction(pool, id);
  console.warn(
    `[moderation] user ${userId} ${restriction.kind}${restriction.endsAt ? ` until ${restriction.endsAt.toISOString()}` : ''}` +
      ` (${adminId ? `by admin ${adminId}` : 'automatic'}): ${JSON.stringify(evidence)}`,
  );
  // An AUTOMATIC strike: tell every admin, by email too (Phase 7), naming the account. Not awaited:
  // a mail problem must not undo the restriction.
  if (!adminId) emailAdmins(restriction).catch((err) => console.warn(`[mail] admin alert: ${err.message}`));
  return restriction;
}

async function emailAdmins(r) {
  const { rows } = await pool.query("SELECT email FROM users WHERE role = 'admin'");
  const signals = Object.entries(r.evidence?.signals ?? {})
    .map(([kind, count]) => `${count} × ${kind}`)
    .join(', ');
  for (const { email } of rows) {
    await sendMail({
      to: email,
      subject: `⚠ Bot detected: ${r.userEmail} was ${r.kind}`,
      text:
        `${r.userEmail} was ${r.kind} automatically for bot-like activity.\n\n` +
        `Evidence: score ${r.evidence?.score} in ${r.evidence?.windowMinutes} minutes (${signals}).\n` +
        (r.endsAt ? `Booking is paused until ${new Date(r.endsAt).toUTCString()}.\n` : 'The account is banned.\n') +
        `\nReview it on the admin Restrictions page (lift it, or overturn it if it was a mistake).`,
    });
  }
}

// A restricted person gives up what they were holding on to, so real fans get it:
// unpaid orders and holds (tickets back on sale), places in waiting rooms, passes.
async function cleanUpAfterRestriction(userId) {
  const holdIds = new Set(await repo.expirePendingOrders(pool, userId));
  for await (const batch of redis.scanStream({ match: `event:*:user:${userId}:hold`, count: 500 })) {
    for (const key of batch) {
      const holdId = await redis.get(key);
      if (holdId) holdIds.add(holdId);
    }
  }
  for (const holdId of holdIds) await releaseHold(holdId);
  await removeUserFromWaitingRooms(userId);
}

// What the site tells a person (and enforces): null, or { kind, until, reason }.
export async function restrictionFor(userId, client = null) {
  if (!client && !(await maybeRestricted(userId))) return null; // not on the list: the common case
  const r = client
    ? await repo.activeRestriction(client, userId)
    : await restrictionCache.get(String(userId), () => repo.activeRestriction(pool, userId));
  if (!r && !client) await redis.srem(RESTRICTED, String(userId)); // over (or lifted): off the list
  return r && { id: r.id, kind: r.kind, until: r.endsAt, reason: r.reason, since: r.startsAt };
}

// ---------- admins ----------

export const listRestrictions = ({ activeOnly }) => repo.listRestrictions(pool, { activeOnly });

// The admin's notification: "2 new" + who (email) and why, until an admin marks them as seen.
export const unseenRestrictions = () => repo.unseenRestrictions(pool);
export const acknowledgeRestrictions = (adminId) => repo.acknowledgeAll(pool, adminId);

export async function restrictByEmail({ adminId, email, kind, days, reason }) {
  const userId = await repo.findUserIdByEmail(pool, email);
  if (!userId) throw new AppError(404, 'USER_NOT_FOUND', 'No user with this email');
  if (userId === adminId) throw new AppError(409, 'CANNOT_RESTRICT_SELF', 'You cannot restrict your own account');
  const restriction = await strike(userId, { reason, adminId, kind, days, evidence: { manual: true } });
  return restriction;
}

// Lift (end early). overturn = it was a MISTAKE: then it doesn't count as a strike either.
export async function lift({ adminId, restrictionId, reason, overturn }) {
  const r = await repo.findRestriction(pool, restrictionId);
  if (!r) throw new AppError(404, 'RESTRICTION_NOT_FOUND', 'No restriction with this id');
  const lifted = await repo.liftActive(pool, { userId: r.userId, adminId, reason, overturn });
  forgetRestriction(r.userId);
  await redis.srem(RESTRICTED, String(r.userId));
  if (lifted === 0) throw new AppError(409, 'NOT_IN_FORCE', 'This restriction is no longer in force');
  console.warn(`[moderation] admin ${adminId} lifted restrictions of user ${r.userId}${overturn ? ' (overturned)' : ''}: ${reason}`);
  return repo.findRestriction(pool, restrictionId);
}

// An upheld appeal (support inbox): overturn, inside the caller's transaction.
export async function overturnForAppeal(client, { userId, adminId }) {
  return repo.liftActive(client, { userId, adminId, reason: 'Appeal upheld', overturn: true });
}
