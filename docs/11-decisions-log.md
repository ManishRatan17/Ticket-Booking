# 11 · Decisions log

Every significant choice, the alternatives considered, and why. Newest at the bottom of each section.

## Foundations

| Decision | Alternatives | Why |
|---|---|---|
| Redis for contended short-lived state, PostgreSQL as the truth | only PostgreSQL; only Redis | Redis handles one hot counter in microseconds; PostgreSQL gives durability and constraints. If they disagree, PostgreSQL wins |
| Plain SQL with `pg` | Prisma / an ORM | learning SQL, transactions and locks directly |
| Hand-written migration runner | a migration library | small, transparent; each file in its own transaction; idempotent |
| Node's built-in test runner (server), Vitest (client) | Jest | no extra dependency on the server; Vitest matches Vite |
| Docker Compose for the databases only; Node runs on the host | everything in Docker | instant restarts and easy debugging while developing (containerise for deployment) |
| `restart: unless-stopped` | manual restarts | containers come back after Docker or the PC restarts |
| ESLint | oxlint | oxlint's native binary is blocked by Windows Application Control on this machine |

## Concurrency (Phase 1)

| Decision | Alternatives | Why |
|---|---|---|
| Show the broken check-then-act version first and keep it | only show the fix | the before/after demo is the clearest explanation of the problem |
| Lua script for holds | `DECRBY` + undo; PostgreSQL `FOR UPDATE` | atomic without false refusals or lost tickets; no queueing on one row |
| One active hold per user per event; max 4 tickets; 5 minutes | no limits | stops one person (or bot) holding everything |
| Holds expire via an `expiresAt` field, released explicitly | Redis TTL | a TTL would delete the record and lose the tickets |
| Lazy expiry of your own hold (in the script) and on read | wait for the Phase 3 worker | nobody is blocked by their own stale hold |
| Redis's clock (`TIME`) for every expiry | Node's clock | one clock; servers' clocks differ |
| Stock created with the event + rebuilt from PostgreSQL (`SET NX`) when missing | load at startup only; count from PostgreSQL every request | survives Redis restarts at any time; `NX` prevents a late rebuild creating tickets |
| `serverTime` in responses | trust the browser clock | correct countdowns on devices with wrong clocks |
| The server enforces `saleStartsAt` | only hide the button | the browser is not a security boundary |
| Hold rate limit later (Phase 5) | now | scope; one-hold-per-user already limits abuse |

## Authentication

| Decision | Alternatives | Why |
|---|---|---|
| Build full auth before Phase 1 Step 4 (user's request) | keep blueprint order | real users needed for holds and later orders |
| argon2id (19 MiB, t=2, p=1) | bcrypt | OWASP's first choice; memory-hard |
| 10–128 chars + top-1,000 common list, no forced complexity | composition rules; HIBP API | NIST guidance; offline; the max stops hashing DoS |
| 409 `EMAIL_TAKEN` on register | generic message | honest UX; rate limiting slows enumeration (generic needs email verification) |
| `jose`, HS256 for our tokens | `jsonwebtoken`; RS256 | modern library; one server signs and verifies |
| 15-min access token + rotating refresh token (7 days sliding, 30-day session) | long-lived JWT; sessions only | fast checks with revocable long-term login |
| Refresh-token reuse detection with a 10-s grace window | strict (always revoke) | detect theft without logging out users with two tabs |
| Redis revoked-session check on every request, **fail closed** | accept 15-min window; fail open | logout and theft response take effect instantly; never let a revoked token through |
| **Both tokens in HttpOnly Secure SameSite=Strict cookies**, cookie-only auth (user's request) | access token in JS memory + Bearer header | XSS can't steal tokens; the frontend holds no secrets. Cost: CSRF protection becomes our job |
| CSRF: SameSite=Strict + `Sec-Fetch-Site`/`Origin` guard | SameSite alone; CSRF tokens | two layers, no extra round trips |
| `COOKIE_SECURE` escape hatch (default on, never off in production) | always Secure | some local tools refuse Secure cookies over http |
| Roles `user`/`admin`; first admin via CLI; default-deny admin router | API to promote; per-route guards | no self-promotion path; no route can forget the guard |
| Demotion revokes sessions instantly; promotion at next refresh | revoke on every change | losing power must be instant; gaining it can wait |
| Last admin protected with row locks + actor re-check inside the transaction | count-then-update | check-then-act and TOCTOU races |
| Rate limiting: fixed window in Lua, **fail open**, IP + email for login failures | sliding window; token bucket; per-email only | simple and atomic; protection, not security; avoids lock-out attacks |
| `TRUST_PROXY` explicit | trust `X-Forwarded-For` | the header can be forged |
| Password reset: `#fragment` token, 15 min, single use, newest only, async email, revoke all sessions, redirect to login | `?query`; auto-login | keep tokens out of logs; no timing leak; evict whoever knew the old password |
| Console mailer behind a transport interface | real provider now | no setup needed; swappable at deployment |
| Google: hand-built OIDC with `jose` + `fetch` | `openid-client` | every step visible for learning; `jose` does the cryptography |
| Google linking: "verified email wins" | refuse and ask to link manually | defeats account pre-hijacking without extra UI |

## Orders & payment (Phase 2)

| Decision | Alternatives | Why |
|---|---|---|
| `npm run seed:demo` + home page lists events | manual setup only | a fresh database showed only the sign-in pages |
| Money as whole **paise** (`INTEGER`) | decimals / floats | `0.1 + 0.2 ≠ 0.3`; Razorpay also uses paise |
| Price read from the database when ordering | price sent by the client | the client must never choose what it pays |
| `Idempotency-Key` header made by the browser per checkout attempt; `ON CONFLICT DO NOTHING` | key derived from the hold | industry standard; same key → same order even under 10 parallel clicks |
| One order per hold (partial unique index) | — | a second tab with another key gets `409 ORDER_EXISTS` + the existing order |
| Order deadline = hold deadline; lazy expiry on read | separate timer | one clock, one rule; the Phase 3 worker will expire everyone |
| Ticket numbers from `events.tickets_sold` with a `CHECK` | `MAX()+1`; Redis counter | atomic, and the database refuses an oversell itself |
| Fake provider + HMAC-signed webhook (2b) | browser says "paid"; Razorpay now | never trust the client for money; same shape as Razorpay |
| Late payment: confirm if tickets still available, else failed + refund needed (2c) | always refuse | fair and safe |

## Background jobs (Phase 3)

| Decision | Alternatives | Why |
|---|---|---|
| BullMQ, one delayed "expire-hold" job per hold, scheduled when the hold is created | a timer scanning every few seconds; Redis key-expiry notifications | precise timing, retries, dead-letter queue; key-expiry events are not guaranteed to be delivered |
| Worker in its own process (`npm run worker`, also started by `npm run dev`) | inside the API process | crash isolation; API and workers restart and scale separately |
| One job expires the hold AND its pending order | two jobs | the order's deadline is the hold's deadline: one clock, one rule |
| Job delay measured with Redis's clock; a job that runs early fails and is retried | Node's clock | expiresAt comes from Redis |
| Jobs idempotent (`already_gone`, release returns tickets once) | — | BullMQ delivers at least once |
| Failed jobs kept (`removeOnFail: false`) | auto-delete | a dead-letter queue: nothing fails silently |
| Scheduling failure does not fail the hold | fail the request | the 3b safety-net sweep catches missing jobs |
| Safety net: sorted-set index `holds:by-expiry` maintained inside the Lua scripts + a 60-second sweep | `SCAN hold:*` every time; no safety net | one fast query; atomic, so the index never disagrees with the holds |
| Sweep loops in batches of 500 until done (≤ 50 batches/run) | one batch per run | more than 500 holds can expire in a minute after a big sale |
| `upsertJobScheduler` for the sweep, called by every worker at startup | one designated scheduler process | idempotent: still exactly one schedule |
| `HOLD_SECONDS` configurable (default 300) | constant | tests use 1-second holds |
| Separate Redis connection for BullMQ (`maxRetriesPerRequest: null`) | share the API's fail-fast connection | workers must wait for Redis, API requests must not |

## Waiting room (Phase 4)

| Decision | Alternatives | Why |
|---|---|---|
| Per-event `admission_per_second` (NULL = no room) | always on; global setting | existing events and tests unchanged; each sale chooses its own rate |
| Sorted set with arrival numbers from `INCR` | Redis list; timestamps as scores | O(log n) position lookups; one place per user; counters never tie |
| Join and admit as Lua scripts | separate commands | joining twice / admitting twice / leaving a room un-checked are all check-then-act races |
| Admission worker: N per second for rooms in `wr:active` | admit when someone leaves | predictable load (admission control); only active rooms are checked |
| Pass = Redis key with a 10-minute TTL | a signed token | instant revocation possible, one lookup, expiry handled by Redis (no side effect needed — a fit for TTL) |
| Queue opens before the sale (lobby) | only after the sale opens | fair order among people who came early; admission starts at sale time |
| Must be signed in to queue | anonymous queue | one place per account; bots need accounts (Phase 5 adds more) |

## Protection (Phase 5)

| Decision | Rejected | Why |
|---|---|---|
| Ticket-path limits per **user** (strict) and per **IP** (generous) | per IP only | many real buyers share one IP (campus Wi-Fi); a per-user limit is exact |
| Per-IP limit **before** `authenticate`, per-user after | both after | turn floods away before any cookie work; per-user needs `req.user` |
| Reuse the fixed-window limiter | token bucket, sliding log | already tested; the window-edge burst is harmless when one hold per user is enforced anyway |
| Purchase cap 4 per person per event, checked in `create-hold.lua` **and** in the payment transaction | Redis only; PostgreSQL only | Redis refuses fast and atomically; PostgreSQL (event row locked) is the truth and sees simultaneous payments Redis can't |
| `bought` counted inside `consume-hold.lua` | a separate `INCRBY` after the commit | no gap where the hold is gone but not yet counted |
| Over the cap at payment → `failed` + refund logged | reject the webhook | the money already moved; same policy as a late payment that finds no tickets |
| At most 3 live streams per user, extra tabs poll | one stream (newest wins); counter in server memory; browser-only `BroadcastChannel` | simple, works with several servers, and the server enforces it (a script ignores the browser) |
| Stream count with a 15-min TTL, deleted at 0 | no TTL | a crashed server can't leave slots taken forever, and the count can never go negative |
| Cloudflare Turnstile on register and queue join | proof-of-work; honeypot only; email verification | stops automated browsers, free, invisible for most people; PoW only adds cost; email verification needs a real mail provider (Phase 7) |
| Bot check fails **open** when Cloudflare is unreachable, closed on a wrong secret | always closed | an outage elsewhere must not stop a sale; our own misconfiguration must be loud |
| Site key served by `GET /api/config` | a Vite env variable | one place to configure; client and server can't disagree |
| Bot check after validation | before | a typo doesn't use up the single-use token |
| Honeypot answers like a failed check | pretend success | tells a bot nothing, and keeps the code simple |

## Waiting room, part 2 (lobby window, fair draw, chance)

| Decision | Rejected | Why |
|---|---|---|
| The lobby opens `lobby_minutes` (default 15) before the sale | joining any time after the event is created | nobody can take place #1 days ahead; a short window keeps the lobby small and honest |
| Window checked inside `join-queue.lua` with Redis `TIME` | checked in Node | one clock for every server, and the check and the join are one atomic step |
| **Hybrid order**: random places for everyone in the lobby, first come first served after the sale opens | pure first come; pure random | first come rewards the fastest click (and bots) and just moves the spike; pure random lets latecomers overtake people who waited |
| Random score at join time (lobby < 1, later arrivals ≥ 1) | a shuffle job at the sale's start | no extra moving part that could fail or run late at the busiest second; admission and positions work unchanged |
| Random numbers from Node `crypto.randomBytes`, passed to Lua | Lua `math.random` | a proper random source, nothing predictable |
| Chance shown as a level (good / maybe / unlikely), assuming 2 tickets per buyer | an exact percentage | the inputs are guesses; a precise-looking number would mislead |
| Two kinds of sold out: `all_held` (stock 0, holds may come back) and `sold_out` (every ticket paid, from PostgreSQL) | one "sold out" | telling people to leave while tickets may still come back would be wrong, and so would making them wait when none can |
| Admission pauses while the stock is 0 | keep admitting | a pass with nothing to buy is wasted; returned tickets should go to the next people in line |
| Positions hidden in the lobby | show the drawn place early | "drawn at 11:00" is clearer, and nobody refreshes hoping for a better number (re-joining keeps the score anyway) |

## Lucky draw

| Decision | Rejected | Why |
|---|---|---|
| A separate Redis stock for the draw's tickets | one stock with a "reserved" number | the line physically can't take them; the same atomic Lua scripts work for both pools |
| Every hold and order records its pool | infer it later | released, expired and late-paid tickets must go back to (or come from) the right pool, and each pool must be rebuildable from PostgreSQL |
| At most 50 %, needs a waiting room | any % | at 100 % the line is pointless; the entrants are the waiting room |
| Provably fair draw: commit (SHA-256 of a secret seed, public from the start), reveal at the draw | "trust us" | the admin can't pick winners or re-roll the seed after seeing who entered; anyone can check |
| Draw number = HMAC-SHA256(seed, "event:user"), lowest wins | shuffle the list with a seeded generator | each number depends only on the seed and that person: simple to check, unaffected by who else joined |
| Draw at a fixed time, then 2 more rounds and a close, each a full round after the previous | draw when the normal tickets run out | predictable and can't be gamed; winners always get their full 10 minutes, even after a worker outage |
| Entrants frozen at round 1 | keep adding people | the draw must be reproducible from the seed and a fixed list |

## Frontend

| Decision | Alternatives | Why |
|---|---|---|
| `react-router-dom` | state-based views | real URLs, back button, deep links from emails |
| One API client with single-flight refresh | fetch in every page | one place for refresh, retries and errors |
| Session-over 401 codes mark the user signed out without refreshing | refresh on every 401 | a refresh can't revive a revoked session |
| Route guards as convenience only | — | the server enforces 401/403 anyway |
| Plain CSS, minimal styling for now (user's request) | Tailwind / a UI library | learning focus; styling in Phase 7 |

## Testing

| Decision | Why |
|---|---|
| Real databases in tests (not mocks) | the bugs that matter here are concurrency bugs in Redis/PostgreSQL |
| Mutation testing for every protection | proves the tests can fail |
| Bulk-created sessions for the 300-user race | the race is about holds, not login speed |
| Pooled HTTP client in the race test | Windows refuses big bursts of new local connections; pools are realistic |

## Known limitations (accepted for now)

- Other users' expired holds wait for the Phase 3 worker.
- Holds are lost if Redis loses its data.
- Password-reset emails can be lost if the server crashes at that moment (Phase 3 queue).
- Tests share the development database.
- Lua scripts are single-Redis (no Cluster hash tags).
- Role changes are audited only in the console log.
