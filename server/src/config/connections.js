import { pool } from './db.js';
import { redis } from './redis.js';
import { closeQueue } from '../jobs/queue.js';

// Close every connection so the process can exit cleanly
// (used on shutdown and at the end of tests). The job queue has its own Redis connection.
export async function closeConnections() {
  await Promise.allSettled([closeQueue(), pool.end(), redis.quit()]);
}
