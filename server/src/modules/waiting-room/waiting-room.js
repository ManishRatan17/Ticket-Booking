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
import { randomBytes } from 'node:crypto';
import { redis } from '../../config/redis.js';
import { env } from '../../config/env.js';

const PREFIX = env.waitingRoom.prefix;
export const ACTIVE_ROOMS = `${PREFIX}:active`;
export const queueKey = (eventId) => `${PREFIX}:${eventId}:queue`;
const seqKey = (eventId) => `${PREFIX}:${eventId}:seq`;
export const passKey = (eventId, userId) => `${PREFIX}:${eventId}:pass:${userId}`;
// The lucky draw's entrants: everyone who joined this event's waiting room (a set).
export const entrantsKey = (eventId) => `${PREFIX}:${eventId}:entrants`;
export const roomKeysPattern = (eventId) => `${PREFIX}:${eventId}:*`; // for cleanup
const lua = (file) => readFileSync(new URL(`./lua/${file}`, import.meta.url), 'utf8');

redis.defineCommand('wrJoin', { numberOfKeys: 5, lua: lua('join-queue.lua') });
redis.defineCommand('wrAdmit', { numberOfKeys: 2, lua: lua('admit.lua') });
redis.defineCommand('wrStreamOpen', { numberOfKeys: 1, lua: lua('stream-open.lua') });
redis.defineCommand('wrStreamClose', { numberOfKeys: 1, lua: lua('stream-close.lua') });

// A random number in [0, 1) for the lobby's fair draw (join-queue.lua explains the draw).
// 6 bytes from crypto.randomBytes = 48 random bits from a cryptographically secure source: nobody
// can predict or steer it. 48 bits: ties between two people are practically impossible (and a tie would be
// broken by user id, still not by arrival time).
export const drawScore = () => randomBytes(6).readUIntBE(0, 6) / 2 ** 48;

// Join (or re-join: you keep your place). Returns a status (see describe()), or
// { status: 'not_open' } before the lobby window opens.
export async function joinQueue(eventId, userId, { lobbyOpensAtMs, saleStartsAtMs, hasLuckyDraw = false }) {
  const [status, a, b] = await redis.wrJoin(
    queueKey(eventId),
    seqKey(eventId),
    passKey(eventId, userId),
    ACTIVE_ROOMS,
    entrantsKey(eventId),
    userId,
    eventId,
    lobbyOpensAtMs,
    saleStartsAtMs,
    drawScore(),
    hasLuckyDraw ? '1' : '0',
  );
  if (status === 'not_open') return { status };
  if (status === 'admitted') return { status, passExpiresInSeconds: a };
  if (status === 'lobby') return { status, total: a }; // no position yet: it's drawn when the sale opens
  return { status, position: a, total: b };
}

// Where am I? Read-only (several separate reads: fine for DISPLAY, nothing is decided on it).
// inLobby = the sale hasn't started: positions are not shown yet (they're a random draw).
export async function queueStatus(eventId, userId, { inLobby = false } = {}) {
  const [passTtl, rank, total] = await Promise.all([
    redis.ttl(passKey(eventId, userId)),
    redis.zrank(queueKey(eventId), String(userId)),
    redis.zcard(queueKey(eventId)),
  ]);
  if (passTtl > 0) return { status: 'admitted', passExpiresInSeconds: passTtl };
  if (rank === null) return { status: 'not_in_queue' };
  if (inLobby) return { status: 'lobby', total };
  return { status: 'waiting', position: rank + 1, total };
}

// LUCKY DRAW winners get a "lucky pass" (set by the draw): it lets them hold tickets from the
// draw's own pool, whether or not the line has reached them yet.
export const luckyPassKey = (eventId, userId) => `${PREFIX}:${eventId}:lucky:${userId}`;
export async function hasLuckyPass(eventId, userId) {
  return (await redis.exists(luckyPassKey(eventId, userId))) === 1;
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

// A restricted person leaves every waiting room: their places, passes and lucky passes go.
export async function removeUserFromWaitingRooms(userId) {
  for (const eventId of await redis.smembers(ACTIVE_ROOMS)) await redis.zrem(queueKey(eventId), String(userId));
  for (const pattern of [`${PREFIX}:*:pass:${userId}`, `${PREFIX}:*:lucky:${userId}`]) {
    for await (const batch of redis.scanStream({ match: pattern, count: 500 })) if (batch.length) await redis.del(...batch);
  }
}

export async function activeRooms() {
  return redis.smembers(ACTIVE_ROOMS);
}

// A room whose event no longer exists: forget it entirely.
export async function dropRoom(eventId) {
  await redis.srem(ACTIVE_ROOMS, String(eventId));
  await redis.del(queueKey(eventId), seqKey(eventId));
}
