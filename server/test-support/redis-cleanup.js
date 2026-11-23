// Removes every Redis key a test created for its events: the stock, the holds (found by their
// eventId), the per-user hold links, and the holds' entries in the expiry index.
// One shared helper, so no test file can forget a kind of key (that used to leave stale holds).
import { redis } from '../src/config/redis.js';
import { HOLDS_BY_EXPIRY } from '../src/modules/reservation/holds.js';

export async function deleteEventKeys(eventIds) {
  const ids = new Set(eventIds.map(String));
  if (ids.size === 0) return;

  const holdIds = [];
  for await (const batch of redis.scanStream({ match: 'hold:*', count: 1000 })) {
    for (const key of batch) if (ids.has(await redis.hget(key, 'eventId'))) holdIds.push(key.slice('hold:'.length));
  }

  const keys = holdIds.map((id) => `hold:${id}`);
  for (const id of ids) {
    for await (const batch of redis.scanStream({ match: `event:${id}:*`, count: 1000 })) keys.push(...batch);
  }

  for (let i = 0; i < keys.length; i += 500) await redis.del(...keys.slice(i, i + 500));
  for (let i = 0; i < holdIds.length; i += 500) await redis.zrem(HOLDS_BY_EXPIRY, ...holdIds.slice(i, i + 500));
}
