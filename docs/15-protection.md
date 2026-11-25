# 15 · Protection (Phase 5)

Phases 1–4 make the sale **correct** (never oversell) and **fair** (first come, first served). Phase 5 stops people and scripts from **abusing** a correct and fair system: flooding it, buying everything with one account, opening thousands of tabs, or making thousands of fake accounts.

## Threats and defences

| Threat | Defence | Step |
|---|---|---|
| A script hammers hold / queue / checkout thousands of times a second | **rate limits** per user (strict) and per IP (generous) | 5a ✅ |
| One account buys again and again (hold 4 → pay → hold 4 → …) | **purchase cap**: 4 tickets per account per event | 5b ⬜ |
| Thousands of open tabs, each checking Redis every second | **cap on live streams** per user | 5c ⬜ |
| Thousands of fake accounts made by bots | **bot check** (Cloudflare Turnstile) + honeypot | 5d ⬜ |

Already in place before Phase 5:

| Threat | Defence | Where |
|---|---|---|
| Two tabs queueing | one queue place per user (re-joining keeps your place) | [14](14-waiting-room.md) |
| Two tabs holding | one hold per user per event | [07](07-tickets-and-holds.md) |
| Double-clicked Checkout | Idempotency-Key | [12](12-orders-and-payments.md) |
| Password guessing, sign-up and email floods | auth rate limits | [06](06-security.md#rate-limiting-in-detail) |

## 5a · Rate limits on the ticket path

All in one file: [server/src/lib/ticketRateLimits.js](../server/src/lib/ticketRateLimits.js). They reuse the Phase-A7 limiter ([lib/rateLimiter.js](../server/src/lib/rateLimiter.js)): a fixed-window counter in Redis, counted by one Lua script (count first, then decide, so 100 parallel requests get counts 1…100 and only the first `limit` pass).

| Endpoint | Per user | Per IP |
|---|---|---|
| `POST /events/:id/holds` | 10 / min | 120 / min |
| `DELETE /holds/:id` | 20 / min | — |
| `POST /events/:id/queue` (join) | 10 / min | 60 / min |
| `GET /events/:id/queue` (status; the page polls every 2 s = 30/min when its stream breaks) | 60 / min | — |
| `GET /events/:id/queue/stream` (opening a stream) | 20 / min | — |
| `POST /orders` | 10 / min | — |
| `POST /payments/fake/:orderId` | 10 / min | — |

Over the limit → `429 RATE_LIMITED`, `Retry-After: <seconds>`, message "Too many attempts. Try again in 42 seconds." The page shows that message.

### Why two kinds of key

```
holdPerIp ──► authenticate ──► holdPerUser ──► validate ──► hold
 (generous)    (who are you?)    (strict)
```

- **Per user** (`user:<id>`), strict: one account can't hammer the sale. It needs `req.user`, so it runs **after** `authenticate`.
- **Per IP**, generous: one machine can't hammer it with many accounts. It runs **before** `authenticate`, so a flood is turned away before we even check its cookie. Generous on purpose: a whole college Wi-Fi or office shares **one** public IP, and those are real buyers. A strict per-IP limit would block a hostel full of students.
- Not signed in → `401` from `authenticate`. Those requests use a little of the IP budget, never anyone's user budget.

### Why these numbers

A person clicking as fast as they can never reaches them; a script does in seconds. Refused requests still count (a script that keeps getting `409 HOLD_EXISTS` is still a script).

### Options considered

| Option | Verdict |
|---|---|
| **Fixed window (the existing limiter)** ✅ | already built, tested and mutation-tested; one Lua call. Weakness: up to 2× the limit across a window edge (10 at 0:59 + 10 at 1:00). Harmless here: 20 hold attempts in 2 s still can't take more than one hold |
| Token bucket | smooth, allows bursts by design; new Lua for a benefit we don't need |
| Sliding log (sorted set of timestamps) | exact; stores every request, which is what a flood is made of |

### Fail open

If Redis is down, the limiter **lets requests through** (and logs a warning): it protects capacity, it doesn't decide who you are. Holding tickets needs Redis anyway, so a Redis outage stops the sale regardless.

### Behind a proxy

`req.ip` is the real client only when `TRUST_PROXY` tells Express which proxy to believe (see [06](06-security.md#rate-limiting-in-detail)). Without it, behind a load balancer every request would share the balancer's IP.

*Tested in [ticket-rate-limits.test.js](../server/test/ticket-rate-limits.test.js): 11th hold → 429 with `Retry-After`, another user on the same IP unaffected; **13 accounts × 10 holds from one IP all at once → exactly 10 refused** (130 − 120); another IP unaffected; release 20; join 10 and status 60 (separate budgets); join per IP 60; orders and payments 10; anonymous floods → 401 and don't use anyone's budget. Mutation: hold limiters removed → both hold tests fail.*
