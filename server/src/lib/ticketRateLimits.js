// The rate limits for the TICKET path (Phase 5a): queue, holds, orders, payments — all in one place.
// (The auth endpoints have their own: modules/auth/auth.rate-limits.js.)
//
// Two kinds of key:
//  • per USER (strict): one account can't hammer the sale. Runs AFTER authenticate, so req.user exists.
//  • per IP (generous): one machine can't hammer it with many accounts. Generous on purpose:
//    a whole college Wi-Fi or office shares ONE public IP, and those are real buyers.
//    Runs BEFORE authenticate, so a flood is turned away before we even check its cookie.
//
// The numbers: a person clicking fast never reaches them; a script does within seconds.
import { rateLimit } from './rateLimiter.js';

const MINUTE = 60;
const byIp = (req) => req.ip;
const byUser = (req) => `user:${req.user.id}`;

// Holding tickets: the most contended endpoint (every hold runs a Lua script on the stock).
export const holdPerIp = rateLimit({ name: 'hold-ip', limit: 120, windowSeconds: MINUTE, key: byIp });
export const holdPerUser = rateLimit({ name: 'hold-user', limit: 10, windowSeconds: MINUTE, key: byUser });
export const releasePerUser = rateLimit({ name: 'release-user', limit: 20, windowSeconds: MINUTE, key: byUser });

// Waiting room. Joining twice keeps your place anyway, so 10/min is plenty for a person.
export const queueJoinPerIp = rateLimit({ name: 'queue-join-ip', limit: 60, windowSeconds: MINUTE, key: byIp });
export const queueJoinPerUser = rateLimit({ name: 'queue-join-user', limit: 10, windowSeconds: MINUTE, key: byUser });
// The page polls every 2 s (30/min) when its live stream breaks: 60 leaves room for two tabs.
export const queueStatusPerUser = rateLimit({ name: 'queue-status-user', limit: 60, windowSeconds: MINUTE, key: byUser });
// Opening a stream (the browser reconnects every 2 s after a drop, so 20/min is generous).
export const queueStreamPerUser = rateLimit({ name: 'queue-stream-user', limit: 20, windowSeconds: MINUTE, key: byUser });

// Checkout. A person makes one order per hold and pays it once or twice (a failed card, then a retry).
export const orderPerUser = rateLimit({ name: 'order-user', limit: 10, windowSeconds: MINUTE, key: byUser });
export const payPerUser = rateLimit({ name: 'pay-user', limit: 10, windowSeconds: MINUTE, key: byUser });
