// The waiting room's data, all in Redis (Phase 4). Prefix "wr" (WAITING_ROOM_PREFIX; tests use their own):
//
//   wr:<eventId>:queue        SORTED SET  member = user id, score = arrival number (1, 2, 3 …)
//   wr:<eventId>:seq          counter that hands out arrival numbers
//   wr:<eventId>:pass:<user>  "admitted" — expires after env.waitingRoom.passSeconds
//   wr:active                 SET of event ids whose room has people waiting (for the worker)
//   wr:streams:<user>         how many live queue streams that user has open (Phase 5c)
//
// Why a sorted set: "what's my position?" is ZRANK — one fast command, even with 100,000 people
// in line — and ZADD only adds a member once, so a second tab can't take a second place.
import { readFileSync } from 'node:fs';
import { redis } from '../../config/redis.js';
import { env } from '../../config/env.js';

const PREFIX = env.waitingRoom.prefix;
export const ACTIVE_ROOMS = `${PREFIX}:active`;
export const queueKey = (eventId) => `${PREFIX}:${eventId}:queue`;
const seqKey = (eventId) => `${PREFIX}:${eventId}:seq`;
export const passKey = (eventId, userId) => `${PREFIX}:${eventId}:pass:${userId}`;
export const roomKeysPattern = (eventId) => `${PREFIX}:${eventId}:*`; // for cleanup
const lua = (file) => readFileSync(new URL(`./lua/${file}`, import.meta.url), 'utf8');

redis.defineCommand('wrJoin', { numberOfKeys: 4, lua: lua('join-queue.lua') });
redis.defineCommand('wrAdmit', { numberOfKeys: 2, lua: lua('admit.lua') });
redis.defineCommand('wrStreamOpen', { numberOfKeys: 1, lua: lua('stream-open.lua') });
redis.defineCommand('wrStreamClose', { numberOfKeys: 1, lua: lua('stream-close.lua') });

// Join (or re-join: you keep your place). Returns a status (see describe()).
export async function joinQueue(eventId, userId) {
  const [status, a, b] = await redis.wrJoin(
    queueKey(eventId),
    seqKey(eventId),
    passKey(eventId, userId),
    ACTIVE_ROOMS,
    userId,
    eventId,
  );
  return status === 'admitted' ? { status, passExpiresInSeconds: a } : { status, position: a, total: b };
}

// Where am I? Read-only (several separate reads: fine for DISPLAY, nothing is decided on it).
export async function queueStatus(eventId, userId) {
  const [passTtl, rank, total] = await Promise.all([
    redis.ttl(passKey(eventId, userId)),
    redis.zrank(queueKey(eventId), String(userId)),
    redis.zcard(queueKey(eventId)),
  ]);
  if (passTtl > 0) return { status: 'admitted', passExpiresInSeconds: passTtl };
  if (rank === null) return { status: 'not_in_queue' };
  return { status: 'waiting', position: rank + 1, total };
}

export async function hasPass(eventId, userId) {
  return (await redis.exists(passKey(eventId, userId))) === 1;
}

// Admit the next `count` people. Returns their user ids, in queue order.
export async function admitNext(eventId, count) {
  return redis.wrAdmit(queueKey(eventId), ACTIVE_ROOMS, eventId, count, env.waitingRoom.passSeconds, PREFIX);
}

// ---------- live streams per user (Phase 5c) ----------
// Every open stream holds a connection and reads Redis once a second. A few tabs are normal;
// 5,000 "tabs" from a script are an attack on our capacity. Extra tabs aren't refused service:
// the page falls back to asking every 2 s.
export const MAX_STREAMS_PER_USER = 3;
const STREAM_SLOT_TTL_SECONDS = 15 * 60; // longer than a stream may live (10 min)
export const streamsKey = (userId) => `${PREFIX}:streams:${userId}`;

// true = you may open a stream; false = you already have MAX_STREAMS_PER_USER open.
export async function openStreamSlot(userId) {
  return (await redis.wrStreamOpen(streamsKey(userId), MAX_STREAMS_PER_USER, STREAM_SLOT_TTL_SECONDS)) === 1;
}

export async function closeStreamSlot(userId) {
  await redis.wrStreamClose(streamsKey(userId));
}

export async function activeRooms() {
  return redis.smembers(ACTIVE_ROOMS);
}

// A room whose event no longer exists: forget it entirely.
export async function dropRoom(eventId) {
  await redis.srem(ACTIVE_ROOMS, String(eventId));
  await redis.del(queueKey(eventId), seqKey(eventId));
}
