# 15 · Protection (Phase 5)

Phases 1–4 make the sale **correct** (never oversell) and **fair** (first come, first served). Phase 5 stops people and scripts from **abusing** a correct and fair system: flooding it, buying everything with one account, opening thousands of tabs, or making thousands of fake accounts.

## Threats and defences

| Threat | Defence | Step |
|---|---|---|
| A script hammers hold / queue / checkout thousands of times a second | **rate limits** per user (strict) and per IP (generous) | 5a ✅ |
| One account buys again and again (hold 4 → pay → hold 4 → …) | **purchase cap**: 4 tickets per account per event | 5b ✅ |
| Thousands of open tabs, each checking Redis every second | **cap on live streams** per user | 5c ✅ |
| Thousands of fake accounts made by bots | **bot check** (Cloudflare Turnstile) + honeypot | 5d ✅ |

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

## 5d · Bot check: Cloudflare Turnstile + a honeypot

**The hole:** every defence above is *per account*. An account costs a bot one `POST /register`. With 1,000 accounts, the purchase cap becomes 4,000 tickets and the queue holds 1,000 bot places in front of real fans. The register limit (5 an hour per IP) doesn't help against a bot farm with thousands of IPs.

**The fix:** the two doors bots need most, **creating an account** and **joining a sale's queue**, ask "are you a person?" first.

### How Turnstile works

```
 Browser                                  Our server                          Cloudflare
 ───────                                  ──────────                          ──────────
 1. page loads Cloudflare's widget  ─────────────────────────────────────────► checks the browser
                                                                               (usually no puzzle)
 2. ◄──────────────────────────────────────────────────────────────────────── one-time TOKEN
 3. POST /register   X-Turnstile-Token ──► 4. siteverify(SECRET, token, ip) ──►
                                          ◄── { success: true }  (real, unused, for my site)
                                          5. continue: create the account
```

It's the same shape as Google sign-in ([05](05-google-login.md)): the browser only **carries** something, and our server checks it **with the issuer**, using a secret the browser never sees. A token the browser makes up is refused by Cloudflare.

| Detail | Why |
|---|---|
| [middleware/botCheck.js](../server/src/middleware/botCheck.js) `requireHuman` on `POST /auth/register` and `POST /events/:id/queue` | the doors that make bots *count*. Holds, orders and payments are already behind an account and an admission pass, the purchase cap and rate limits |
| token in a **header** (`X-Turnstile-Token`) | works for a JSON body (register) and for no body at all (join) |
| runs **after** validation (and after `authenticate` on join) | a typo or an expired login costs no Cloudflare call and doesn't use up the visitor's single-use token (tested) |
| sends the visitor's IP (`remoteip`) | Cloudflare can compare it with the browser that solved the check |
| tokens are **single-use** | a bot can't solve once and replay it 1,000 times (tested). The page gets a fresh widget after every attempt |
| 3-second timeout on the call | a slow Cloudflare must not hang our sign-ups |
| **fails open** when Cloudflare is unreachable (network error, timeout, 5xx), with a warning | the same trade-off as the rate limits: an outage at Cloudflare must not stop a sale for every real fan; the other defences still stand |
| …but a **wrong secret** is not "unreachable": refused, and logged as an error | our misconfiguration must be loud, not silently switch bot protection off |
| `GET /api/config` → `{ botCheck: { siteKey } }` | the page learns the PUBLIC site key from the server, so client and server can never disagree about whether the check is on. The secret never leaves the server (tested) |
| both keys or neither (`TURNSTILE_SITE_KEY`, `TURNSTILE_SECRET_KEY`); **required in production** | neither = off (tests, development without keys); a missing key in production must not quietly switch the check off |

**Development keys:** `server/.env.example` contains Cloudflare's public **test** keys (site `1x00000000000000000000AA`, secret `1x0000000000000000000000000000000AA`). The widget always passes, and the server's check **really** goes to Cloudflare. Checked live: no token → `403`; Cloudflare's dummy test token → `201` after a real round trip of ~450 ms. For production: dash.cloudflare.com → Turnstile → add a widget for your domain → put its two keys in the server's environment.

### The honeypot

The register form has a field called `website` that people never see: it's moved off-screen (not `display: none`, which some bots skip), taken out of the Tab order (`tabIndex=-1`) and hidden from screen readers (`aria-hidden`). Simple bots fill in **every** field. `rejectHoneypot` runs **before** validation (validation drops unknown fields) and answers exactly like a failed check, so it tells a bot nothing. Free and offline, but it only catches simple bots; Turnstile is there for the rest.

### In the browser

| File | What it does |
|---|---|
| [hooks/useHumanCheck.js](../client/src/hooks/useHumanCheck.js) | asks `/api/config` once; holds the token; `ready` = check off, or token in hand; `reset()` = fresh widget |
| [components/TurnstileWidget.jsx](../client/src/components/TurnstileWidget.jsx) | loads Cloudflare's script **once** (`?render=explicit`), draws the widget, token → `onToken`; expired or error → `null`; removes the widget on unmount |
| [RegisterPage](../client/src/pages/RegisterPage.jsx), [WaitingRoom](../client/src/components/WaitingRoom.jsx) | the widget above the button; the button waits for a token; after a failed attempt, a fresh widget |

**Deployment note (Phase 7):** if the page is served with a Content-Security-Policy, it must allow `https://challenges.cloudflare.com` in `script-src` and `frame-src`.

### Options considered

| Option | Verdict |
|---|---|
| **Cloudflare Turnstile** ✅ | free, usually invisible, used in real ticketing, stops automated browsers; Cloudflare decides who's a bot (a black box) |
| Proof-of-work (the browser burns ~1 s of CPU on SHA-256) | no outside service and fully understandable, but only a **cost**: a bot farm pays it |
| Honeypot alone | catches simple bots only. Kept, as a free extra layer |
| Email verification before buying | makes throwaway accounts expensive too; needs a real mail provider → Phase 7 idea |

**Not covered:** Google sign-in creates accounts without `/register`; Google's own sign-up is the barrier there. A determined attacker can pay humans to solve checks: Phase 5 raises the **cost** of abuse, it can't make it impossible.

*Tested in [bot-check.test.js](../server/test/bot-check.test.js) against a fake Cloudflare ([fake-turnstile.js](../server/test-support/fake-turnstile.js)): `/api/config` has the site key and not the secret; no token / made-up token / replayed token → 403; good token → 201 and Cloudflare got our secret, the token and the visitor's IP; a form with a typo → 400 without using the token; honeypot → 403 with no account; Cloudflare 500 or dropped connection → allowed; wrong secret → refused; joining a queue needs a token, reading status doesn't; not signed in → 401 before any Cloudflare call. Client: [api/botCheck.test.js](../client/src/api/botCheck.test.js) (the header and the honeypot field are sent). Mutations: `requireHuman` removed from register → 5 tests fail; honeypot disabled → the honeypot test fails.*

## Phase 5 in one picture

```
request ──► per-IP limit ──► authenticate ──► per-user limit ──► validate ──► "are you a person?" ──► …
                                                                               (register, join only)
join the queue (one place per account) ──► admitted (pass) ──► hold (one per account, ≤ 4 bought+held)
     └─ live position: ≤ 3 streams per account, extra tabs poll                  └─ payment: PostgreSQL re-checks ≤ 4
```
