// Rate limiting with Redis: "at most `limit` requests per `windowSeconds` per key".
//
//   router.post('/login', rateLimit({ name: 'login-ip', limit: 30, windowSeconds: 900,
//                                     key: (req) => req.ip }), ...)
//
// Redis (not server memory) holds the counters, so the limit still holds when we run
// several server instances, and survives a server restart.
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { redis } from '../config/redis.js';
import { env } from '../config/env.js';
import { AppError } from './errors.js';

redis.defineCommand('rateLimitHit', {
  numberOfKeys: 1,
  lua: readFileSync(new URL('./lua/fixed-window.lua', import.meta.url), 'utf8'),
});

// Keys may contain emails and IPs. Hashing them keeps personal data out of Redis
// (and gives every key the same length).
const fingerprint = (id) => createHash('sha256').update(id).digest('hex').slice(0, 32);

export function createLimiter({ name, limit, windowSeconds }) {
  const keyFor = (id) => `${env.rateLimits.prefix}:${name}:${fingerprint(id)}`;
  return {
    // Counts this hit FIRST, then decides. Counting first is what makes it safe under
    // concurrency: 100 parallel requests get counts 1..100, so only the first `limit` pass.
    // ("Check, then count" would be Phase 1's check-then-act bug all over again.)
    async hit(id) {
      const [count, ttl] = await redis.rateLimitHit(keyFor(id), windowSeconds);
      return {
        allowed: count <= limit,
        remaining: Math.max(0, limit - count),
        resetSeconds: ttl > 0 ? ttl : windowSeconds,
      };
    },
    async reset(id) {
      await redis.del(keyFor(id));
    },
  };
}

function humanize(seconds) {
  const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
  return seconds < 60 ? plural(seconds, 'second') : plural(Math.ceil(seconds / 60), 'minute');
}

// Express middleware.
//   key(req)        → what to count by (IP, IP + email, …)
//   resetOnSuccess  → a successful request clears the counter. For login: only FAILED
//                     attempts should pile up; a user who logs in fine starts from zero.
export function rateLimit({ name, limit, windowSeconds, key, resetOnSuccess = false }) {
  const limiter = createLimiter({ name, limit, windowSeconds });

  return async (req, res, next) => {
    if (!env.rateLimits.enabled) return next();
    const id = key(req);

    let result;
    try {
      result = await limiter.hit(id);
    } catch (err) {
      // FAIL OPEN: rate limiting PROTECTS the system, it doesn't decide who you are.
      // If Redis is down, blocking everyone would hurt more than briefly allowing extra
      // attempts. (Compare revocation.js, which fails CLOSED: that one IS a security check.)
      console.warn(`[rate-limit] ${name}: Redis unavailable, allowing request (${err.message})`);
      return next();
    }

    // Standard-ish headers so clients can see their budget.
    res.set({
      'RateLimit-Limit': String(limit),
      'RateLimit-Remaining': String(result.remaining),
      'RateLimit-Reset': String(result.resetSeconds),
    });

    if (!result.allowed) {
      res.set('Retry-After', String(result.resetSeconds)); // the official "come back in N seconds"
      throw new AppError(429, 'RATE_LIMITED', `Too many attempts. Try again in ${humanize(result.resetSeconds)}.`, {
        retryAfterSeconds: result.resetSeconds,
      });
    }

    if (resetOnSuccess) {
      // 'finish' fires after the response is sent, so we know how the request ended.
      res.on('finish', () => {
        if (res.statusCode < 400) {
          limiter.reset(id).catch((err) => console.warn(`[rate-limit] ${name}: reset failed (${err.message})`));
        }
      });
    }
    next();
  };
}
