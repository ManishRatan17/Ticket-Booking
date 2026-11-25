# 15 · Protection (Phase 5)

Phases 1–4 make the sale **correct** (never oversell) and **fair** (first come, first served). Phase 5 stops people and scripts from **abusing** a correct and fair system: flooding it, buying everything with one account, opening thousands of tabs, or making thousands of fake accounts.

## Threats and defences

| Threat | Defence | Step |
|---|---|---|
| A script hammers hold / queue / checkout thousands of times a second | **rate limits** per user (strict) and per IP (generous) | 5a ✅ |
| One account buys again and again (hold 4 → pay → hold 4 → …) | **purchase cap**: 4 tickets per account per event | 5b ✅ |
| Thousands of open tabs, each checking Redis every second | **cap on live streams** per user | 5c ✅ |
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

## 5b · Purchase cap: 4 tickets per person per event

**The hole:** paying *consumes* your hold, which frees your "one hold per event" slot. So one account could hold 4 → pay → hold 4 → pay … and empty the event. Rate limits only slow that down.

**The rule:** tickets already bought + the new hold ≤ **4** (`MAX_TICKETS_PER_USER` in [holds.js](../server/src/modules/reservation/holds.js)). Same Redis-fast / PostgreSQL-truth pattern as the stock:

```
 hold request ──► create-hold.lua:  bought + quantity > 4 ?  ──► 409 PURCHASE_LIMIT   (fast, Redis)
                                    │ no
                                    ▼
                                  hold … order … webhook
                                                   │
 payment transaction ──► lock the event row ──► SUM(paid orders) + quantity > 4 ?  ──► failed 'purchase_limit', refund logged
                                                   │ no                                (the truth, PostgreSQL)
                                                   ▼
                         consume-hold.lua: delete the hold AND bought += quantity (one atomic step)
```

| Piece | What it does | Why |
|---|---|---|
| Redis key `event:<id>:user:<uid>:bought` | tickets this user has PAID for at this event | read inside the hold's Lua script: one atomic step, so two quick holds can't both slip under the limit |
| [create-hold.lua](../server/src/modules/reservation/lua/create-hold.lua) | refuses with `{ -3, bought }` before touching stock | a refused hold changes nothing (tested: stock unchanged) |
| [consume-hold.lua](../server/src/modules/reservation/lua/consume-hold.lua) | deletes the paid hold **and** adds its tickets to `bought` | no moment where the hold is gone but not yet counted (otherwise you could hold again in between) |
| `addBought` | a **late** payment (hold already released, tickets taken from stock directly) counts its tickets here | no hold was consumed in that case |
| `ensureBought` ([events.service.js](../server/src/modules/events/events.service.js)) | if Redis has no count, rebuild it from `SUM(quantity)` of paid orders, with `SET NX` | a Redis restart must not reset everyone's count to 0. `NX`: if a payment set it meanwhile, that one wins |
| Payment transaction ([payments.service.js](../server/src/modules/payments/payments.service.js)) | `SELECT … FOR UPDATE` on the **event** row, then paid + this order ≤ 4, else `failed` (`purchase_limit`) + `[refund]` log + the hold released | catches what Redis can't see (below). The lock makes payments for one event take turns, so two can't both read "0 bought". Payments for one event were already serialised on that row (`tickets_sold`); the lock is now just taken a little earlier |

**What can Redis not see?** Two orders paid at the same moment. Example: order A (4 tickets) is pending and its hold expires; you hold 4 again (allowed: nothing is *bought* yet) → order B. Now both get paid. Redis allowed both holds; only the payment transaction, with the event row locked, sees that A was paid first and fails B. Tested exactly like that: **one paid, one refund_needed, never more than 4 paid tickets**.

**Failed and expired orders don't count**, only `status = 'paid'`.

**Client:** `GET /events/:id/holds/mine` now also returns `purchase: { bought, limit }`. The event page offers only `min(4, in stock, limit − bought)` tickets, says "(you already have 2)", and at the limit shows "You've bought the maximum of 4 tickets for this event" with a link to your tickets.

**Not covered here (that's 5d):** one person with **many accounts**. A per-account limit is only as strong as the cost of making an account.

*Tested in [purchase-limit.test.js](../server/test/purchase-limit.test.js): bought 4 → 1 more refused (`details: { bought: 4, limit: 4 }`); bought 2 → 3 refused (stock untouched), 2 fine; per person and per event; failed payments don't count; `purchase` in "my hold"; Redis loses the count → rebuilt from PostgreSQL; two orders paid at once → exactly 4 tickets. Mutations: Lua check removed → the hold tests fail; PostgreSQL check removed → the simultaneous-payments test fails (8 tickets paid).*

## 5c · Duplicate tabs: at most 3 live streams per user

**The hole:** every open queue page holds one HTTP connection and reads Redis once a second (step 4b). Two or three tabs are normal. A script opening 5,000 "tabs" with one account ties up 5,000 connections and 5,000 Redis reads a second. The rate limit (20 opens a minute) only slows that down: an open stream stays open for 10 minutes.

**The rule:** at most **3** open streams per user (`MAX_STREAMS_PER_USER` in [waiting-room.js](../server/src/modules/waiting-room/waiting-room.js)). The 4th gets `429 TOO_MANY_STREAMS`, and that page **still works**: [useQueueStatus](../client/src/hooks/useQueueStatus.js) treats any stream error by asking every 2 s instead (the fallback built in 4c). So extra tabs cost a cheap GET every 2 s instead of a held connection.

```
open a stream ──► stream-open.lua:  INCR count · EXPIRE 15 min · count > 3 ? DECR, refuse : allow
                                                                         │
the stream ends (tab closed, admitted, 10-min limit) ──► stream-close.lua: DECR · at 0, DEL
```

| Detail | Why |
|---|---|
| Redis key `<prefix>:streams:<userId>`, one count per user (all events together) | the cost is per connection, whatever the event |
| **Count first, then decide**, in one Lua script ([stream-open.lua](../server/src/modules/waiting-room/lua/stream-open.lua)) | 10 tabs opening at the same instant get counts 1…10, so exactly 3 pass (tested). A refused open gives its count back |
| Checked **before** the stream starts | the refusal is a normal JSON `429`, not a half-open stream |
| Released in `finish()`, which every ending goes through (tab closed → `req.on('close')`, admitted, the 10-minute limit, an error) | one place, guarded by `closed`, so a slot is given back exactly once |
| **TTL 15 min**, longer than a stream may live (10 min) | if a server crashes, its streams can't run `finish()`. Without a TTL their slots would stay taken forever |
| [stream-close.lua](../server/src/modules/waiting-room/lua/stream-close.lua) deletes the key at 0 | a `DECR` on a key that had already expired would leave `-1` forever (= a 4th slot) |
| `if (req.socket.destroyed) finish()` | a browser that left while we were still setting up has already fired `close`; it won't fire again |

**Options considered:** one stream per user, newer tab wins (more complex: the server must tell the old tab to stop); a counter in server memory (wrong with several API servers, and lost on restart); a `BroadcastChannel` in the browser so tabs share one stream (nice, but a script ignores whatever the browser does, so the server must enforce a limit anyway).

*Tested in [waiting-room-stream.test.js](../server/test/waiting-room-stream.test.js): 3 tabs → 200, the 4th → JSON 429 and not counted, TTL set, another user unaffected, closing a tab frees a slot, all closed → key deleted; **10 tabs at the same instant → exactly 3 streams**; a stream that ends by itself (admitted) gives its slot back. Mutations: cap removed → 2 tests fail; release removed → 3 tests fail.*
