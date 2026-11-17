import { Router } from 'express';
import { checkPostgres } from '../config/db.js';
import { checkRedis } from '../config/redis.js';

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

router.get('/', async (req, res) => {
  // Run both checks at the same time rather than one after the other.
  const [postgres, redis] = await Promise.all([check(checkPostgres), check(checkRedis)]);
  const ok = postgres.status === 'up' && redis.status === 'up';

  // 503 Service Unavailable tells load balancers / monitors "don't send traffic here".
  res.status(ok ? 200 : 503).json({
    status: ok ? 'ok' : 'degraded',
    uptime: process.uptime(),
    services: { postgres, redis },
  });
});

export default router;
