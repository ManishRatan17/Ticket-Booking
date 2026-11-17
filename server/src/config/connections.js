import { pool } from './db.js';
import { redis } from './redis.js';

// Close every connection so the process can exit cleanly
// (used on shutdown and at the end of tests).
export async function closeConnections() {
  await Promise.allSettled([pool.end(), redis.quit()]);
}
