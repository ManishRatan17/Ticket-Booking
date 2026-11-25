// Load test, step 4: remove everything the run created (Phase 6). Run from the repo root:
//
//   node --env-file=server/.env loadtest/cleanup.mjs
import { readFileSync } from 'node:fs';

const server = new URL('../server/', import.meta.url);
const { pool } = await import(new URL('src/config/db.js', server));
const { redis } = await import(new URL('src/config/redis.js', server));
const { closeConnections } = await import(new URL('src/config/connections.js', server));
const { deleteEventKeys } = await import(new URL('test-support/redis-cleanup.js', server));
const { roomKeysPattern, ACTIVE_ROOMS } = await import(new URL('src/modules/waiting-room/waiting-room.js', server));

const run = JSON.parse(readFileSync(new URL('./.data/run.json', import.meta.url), 'utf8'));
const id = run.eventId;

for await (const batch of redis.scanStream({ match: roomKeysPattern(id), count: 1000 })) if (batch.length) await redis.del(...batch);
await redis.srem(ACTIVE_ROOMS, String(id));
await deleteEventKeys([id]);
await pool.query('DELETE FROM sold_tickets WHERE event_id = $1', [id]);
await pool.query('DELETE FROM orders WHERE event_id = $1', [id]);
await pool.query('DELETE FROM events WHERE id = $1', [id]);
const { rowCount } = await pool.query('DELETE FROM users WHERE email LIKE $1', [`${run.run}-%`]);
console.log(`${run.run}: event ${id} and ${rowCount} people removed`);
await closeConnections();
