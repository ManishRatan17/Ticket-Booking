import { Router } from 'express';
import { checkPostgres } from '../config/db.js';
import { checkRedis } from '../config/redis.js';
import { env } from '../config/env.js';
import { getQueue } from '../jobs/queue.js';

const router = Router();

// Rejects if `promise` takes longer than `ms`, so a hung database can't hang the health check.
function withTimeout(promise, ms) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

async function check(fn) {
  try {
    await withTimeout(fn(), 2000);
    return { status: 'up' };
  } catch (err) {
    return { status: 'down', error: err.message };
  }
}

// The background worker is a SEPARATE process (src/worker.js, started by "npm run dev"). Without it,
// abandoned holds aren't released and emails / refunds wait. Reported here so it's visible; it doesn't
// make the API itself unhealthy (the API still answers), so it doesn't change the 200/503.
async function checkWorker() {
  if (!env.jobs.enabled) return { status: 'disabled' };
  try {
    const workers = await withTimeout(getQueue().getWorkers(), 2000);
    return workers.length > 0 ? { status: 'up', count: workers.length } : { status: 'down', error: 'no worker connected: run npm run dev (or npm run worker)' };
  } catch (err) {
    return { status: 'unknown', error: err.message };
  }
}

router.get('/', async (req, res) => {
  // Run the checks at the same time rather than one after the other.
  const [postgres, redis, worker] = await Promise.all([check(checkPostgres), check(checkRedis), checkWorker()]);
  const ok = postgres.status === 'up' && redis.status === 'up';

  // 503 Service Unavailable tells load balancers / monitors "don't send traffic here".
  res.status(ok ? 200 : 503).json({
    status: ok ? 'ok' : 'degraded',
    uptime: process.uptime(),
    services: { postgres, redis, worker },
  });
});

export default router;
