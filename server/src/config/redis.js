import { Redis } from 'ioredis';
import { env } from './env.js';

// One shared connection is enough: Redis handles one command at a time anyway,
// and ioredis pipelines our commands over the same TCP connection.
export const redis = new Redis(env.redisUrl, {
  // If Redis is down, fail a command after 1 retry instead of waiting ~20 retries.
  maxRetriesPerRequest: 1,
});

// ioredis reconnects automatically. Log problems instead of crashing.
redis.on('error', (err) => {
  console.error('[redis] error:', err.message);
});

export async function checkRedis() {
  const reply = await redis.ping();
  if (reply !== 'PONG') throw new Error(`Unexpected PING reply: ${reply}`);
}
