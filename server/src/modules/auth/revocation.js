// Ending sessions — the ONE place that does it, so no code path can revoke "halfway".
//
//   Postgres  sessions.revoked_at      → the truth (refresh tokens stop working)
//   Redis     session:revoked:<sid>    → the fast check every request makes
//                                        (access tokens stop working IMMEDIATELY)
//
// The Redis key only needs to live as long as an access token can (15 min):
// after that, every token the session ever issued has expired by itself.
import { redis } from '../../config/redis.js';
import { pool } from '../../config/db.js';
import { env } from '../../config/env.js';
import { AppError } from '../../lib/errors.js';
import * as sessionsRepository from './sessions.repository.js';

const TTL_SECONDS = env.jwt.accessTtlSeconds;
const key = (sessionId) => `session:revoked:${sessionId}`;

async function markRevokedInRedis(sessionIds, ttlSeconds = () => TTL_SECONDS) {
  if (sessionIds.length === 0) return;
  // MULTI/EXEC sends all the SETs together and Redis applies them as one batch.
  const batch = redis.multi();
  for (const id of sessionIds) batch.set(key(id), '1', 'EX', ttlSeconds(id));
  const results = await batch.exec();
  const failed = results.find(([err]) => err);
  if (failed) throw failed[0];
}

// Both functions must be called with a `client` INSIDE a transaction.
// Order matters: Redis is written BEFORE the transaction commits.
//   Redis fails  → we throw → Postgres rolls back → nothing revoked, the request fails (500).
//   Commit fails → Redis says "revoked" but Postgres doesn't → the user is logged out a bit
//                  early. Annoying, but SAFE. The opposite order could leave a revoked
//                  session usable for 15 minutes.

export async function revokeSession(client, sessionId, reason) {
  const ids = await sessionsRepository.revokeSession(client, sessionId, reason);
  await markRevokedInRedis(ids);
  return ids.length > 0;
}

export async function revokeAllUserSessions(client, userId, reason) {
  const ids = await sessionsRepository.revokeAllUserSessions(client, userId, reason);
  await markRevokedInRedis(ids);
  return ids.length;
}

// Only revokes the session if it belongs to `userId` (see IDOR in the step notes).
export async function revokeOwnSession(client, { sessionId, userId }, reason) {
  const ids = await sessionsRepository.revokeOwnSession(client, { sessionId, userId }, reason);
  await markRevokedInRedis(ids);
  return ids.length > 0;
}

// Called by the authenticate middleware on EVERY protected request.
// FAIL CLOSED: if Redis can't answer, we can't prove the session is still valid,
// so we refuse (503) rather than let a possibly-revoked token through.
export async function isSessionRevoked(sessionId) {
  try {
    return (await redis.exists(key(sessionId))) === 1;
  } catch {
    throw new AppError(503, 'AUTH_UNAVAILABLE', 'Authentication is temporarily unavailable');
  }
}

// Redis can lose data (a restart without persistence, a flush, a new empty instance).
// Postgres is the truth, so we rebuild the Redis keys from it: every session revoked
// in the last 15 minutes gets its key back, with only the TTL it has left.
export async function rebuildRevokedSessions() {
  const { rows } = await pool.query(
    `SELECT id, EXTRACT(EPOCH FROM now() - revoked_at) AS age
       FROM sessions
      WHERE revoked_at > now() - make_interval(secs => $1)`,
    [TTL_SECONDS],
  );
  const remaining = new Map(rows.map((r) => [r.id, Math.max(1, Math.ceil(TTL_SECONDS - Number(r.age)))]));
  await markRevokedInRedis([...remaining.keys()], (id) => remaining.get(id));
  return rows.length;
}

// Rebuild when the server starts AND every time ioredis (re)connects to Redis —
// a Redis restart while our server keeps running would otherwise go unnoticed.
export function keepRevocationsInSync() {
  const run = () =>
    rebuildRevokedSessions()
      .then((n) => n > 0 && console.log(`[auth] restored ${n} revoked session(s) into Redis`))
      .catch((err) => console.error('[auth] could not rebuild revoked sessions:', err.message));
  if (redis.status === 'ready') run();
  redis.on('ready', run);
}
