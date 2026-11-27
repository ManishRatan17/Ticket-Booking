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

## Support inbox

| Decision | Rejected | Why |
|---|---|---|
| Approving "more tickets" raises the limit for that person and event (`purchase_limit_overrides`) | admins buying for people; a global higher limit | the exception stays an exception, and both checks (Redis and PostgreSQL) use the same number |
| Limit read from PostgreSQL on each hold (one PK lookup) | cached in Redis | an approval takes effect at once; one more fast query on a path that already reads the event |
| One open request per person, kind and event | unlimited | asking twice doesn't jump the queue; the person is sent to their existing conversation |
| Decisions only from `open` (`UPDATE … WHERE status = 'open'`), approval + raise in one transaction | check then update | two admins can't both decide; never an approval without its raise |
| Requests kept (event set NULL) if an event is deleted | cascade delete | the conversation is a record |

## Bot strikes (Phase 5e)

| Decision | Rejected | Why |
|---|---|---|
| Strikes only from per-account evidence (refused actions, missing/fake bot tokens), scored over 10 minutes | instant ban on one signal; IP-based signals | detection is never certain; one IP is shared by many real people |
| 20 points / 10 min; missing token 5, fake token 2, refused action 1 | one fixed rule | weights match how sure each signal is (an expired token can happen to a person) |
| Suspension 15 days, ban on a 2nd strike within a year; overturned strikes don't count | permanent ban at once | proportional, and mistakes can be undone |
| Restricted = booking paused, account still usable | log them out | they must see why and be able to appeal |
| Restriction checked in PostgreSQL; expiry by date, no job | a Redis flag + a reopen job | always right; nothing to forget to run |
| Cleanup on a strike (holds, orders, queue, passes) | leave them | a bot account must not keep tickets tied up |
| Appeals in the support inbox; upholding overturns in the same transaction | a separate appeals system | one inbox for people and admins |

## Load testing (Phase 6)

| Decision | Rejected | Why |
|---|---|---|
| k6 in Docker, arrival-rate scenarios | k6 installed on Windows; 10,000 simultaneous virtual users | nothing to install; this laptop can't hold 10,000 virtual users, and the server sees the same arrivals either way |
| The API under test as a Linux container in the Docker network | the API on Windows | Windows / Docker Desktop port forwarding refused connections before they reached Node: that measured the laptop, not the app |
| Verify with SQL after every run | trust k6's error count | "no errors" doesn't prove "not oversold"; the data does |
| Hot data (event, restrictions, limits) cached in memory for 1 s, single-flight | a database query per click; a Redis cache | the load test showed 4 queries per click overwhelming the pool; 1 s of staleness across servers is acceptable, and payment always reads the database |
| Sold-out fast path from Redis before per-person work | the full path for every click | ~97 % of clicks in a sell-out are "sold out"; they shouldn't cost database queries |
| Restricted accounts listed in a Redis set (rebuilt from PostgreSQL, hourly too) | ask PostgreSQL for every new person | a cache can't help people it has never seen |

## The admin side

| Decision | Rejected | Why |
|---|---|---|
| Admins can't buy or send support requests (server 403 + hidden in the page) | only hide the buttons; let admins buy | organisers mustn't compete with fans; hiding alone protects nothing |
| Manage events shows live numbers from where they live (sold: PostgreSQL; left/held/in line: Redis) | a nightly report | admins watch a sale as it happens |
| Edit: name any time; price, time, waiting room only before the sale; tickets and lucky-draw settings never | edit anything | fairness to people who already queued or paid; stock and the draw's seed are built on the fixed values |
| "Jobs" renamed "System" with a worker light | remove the page | an admin must notice when nothing releases holds or admits people |
| Bot notifications: a badge + list with the email, "mark as seen"; hand-made restrictions start as seen | emails now; live pop-ups | works without an email provider (Phase 7); accounts have only an email to identify them |

## Deployment (Phase 7)

| Decision | Rejected | Why |
|---|---|---|
| One service serves the API and the website | a separate static site | same origin: `SameSite=Strict` cookies and the CSRF check work as in development; one address |
| Multi-stage Docker image; migrations at start | build tools in the image; migrations by hand | small image; the database is always current |
| Resend over its HTTP API | SMTP; an SDK | one `fetch`, no new dependency; free tier |
| Emails through the job queue | send inline | retries and crash-safety (a reset email used to be lost on a crash) |
| Railway recommended | Render free tier; Fly.io; a VPS | Dockerfile from GitHub, managed PostgreSQL + Redis, a worker service, simple |
| Razorpay over plain HTTPS + HMAC | the Razorpay SDK | three small functions; no dependency; easy to fake in tests |
| Page confirmation (signature) AND webhook, both into the same transaction | webhook only | the page gets an answer at once; the webhook covers closed tabs; idempotency makes both safe |
| A Razorpay `payment.failed` doesn't fail the order | fail it | it's one attempt; the person can retry in the same window; expiry handles giving up |
| Fake provider OFF when Razorpay is configured | keep both | nobody should get tickets with a fake "Pay" on a real deployment |

## Test database and CI

| Decision | Rejected | Why |
|---|---|---|
| A separate test database (`ticketing_test`) and Redis database 1, created + migrated by `pretest` | sharing the development data | tests and development kept affecting each other (skipped admin tests, load-test users, leftovers) |
| Advisory lock around migrations | hope files don't migrate at the same time | parallel test files (and several servers starting) would race on a fresh database |
| Outside services forced off in `.env.test` | trust `.env` | a developer's real keys must never make tests send real emails or payments |
| GitHub Actions with service containers | no CI; mocks | the same real PostgreSQL and Redis as development, on every push |

## Refunds

| Decision | Rejected | Why |
|---|---|---|
| A `refunds` row in the payment transaction, processed by a job | refund inline in the webhook | the webhook answers at once; the refund is retried if the provider is down; nothing owed is forgotten |
| `UNIQUE (payment_id)` | check in code | a payment can never be refunded twice, whatever runs at the same time |
| Ask the provider first, tagged with our refund id | trust that a failed call refunded nothing | a timeout can hide a refund that happened |

## Admin audit log

| Decision | Rejected | Why |
|---|---|---|
| One middleware on the whole admin router ("default audited") | a `writeAudit` call in every admin route | a new admin route can't forget it, the same idea as "default deny" |
| Recorded after the response, only if it succeeded | before the action; also failures | only what actually changed is history; a refused request changed nothing |
| Append-only by a database trigger | "the code never updates it" | even a bug, or someone with the app's database access, can't quietly rewrite history |
| `admin_email` stored, `admin_id` without a foreign key | a foreign key to users | the record must outlive the admin's account |
| Writes from the command line recorded too ("command line (set-role)") | HTTP only | making the first admin is the most powerful change of all |

## Cancelling an event

| Decision | Rejected | Why |
|---|---|---|
| Mark cancelled, keep everything | delete the event | the event and its orders are the record of who paid and who is owed money |
| The refunds recorded in the cancel's transaction | refund one by one afterwards | if the cancel commits, every refund owed is on record; nobody can be forgotten |
| Orders locked first, the event row last | lock the event first (simpler to read) | payments lock order → event; the opposite order deadlocks (measured: 6 of 8 race runs) |
| The payment re-checks `cancelled_at` under the event lock | trust that the cancel saw every order | an order created in the instant of the cancel would otherwise become tickets for a cancelled event |
| A new order status `cancelled` | reuse `failed` | "the event was cancelled" isn't a failed payment; My orders says which |

## Design system (2026-11-28)

| Decision | Rejected | Why |
|---|---|---|
| Design tokens in one CSS file (custom properties), every colour a token | a UI library (Tailwind, a component kit) | no new dependency, no rewrite of every page; one file to rebrand the site |
| One shared animation scene (SceneBackdrop) + one vehicle livery | a themed background per category | the user's brief: one platform, four categories; only the moving objects differ |
| Tokens straight in SVG attributes (`fill="var(--…)"`) | redraw with CSS classes | browsers resolve them (checked in Chrome): the drawings stay as they were |
| Category accent colours kept, but only on the icon tile, top bar and badge | one colour for everything | a quick recognition aid; the rest of the look is identical |
| Building blocks as CSS classes; React components only where they remove repetition | a component for every button and card | lightweight; the existing pages already use these classes |

## Train booking

| Decision | Rejected | Why |
|---|---|---|
| Its own module and tables (migration 017), separate from bus | one "transport" module | trains have classes, coaches, berths allocated by the operator and PNRs; separate, a change to one can't break the other |
| A provider interface: local inventory by default, an external partner behind `TRAIN_PROVIDER=external` | call an Indian Railways API | there is no public booking API (IRCTC sells itself or via licensed agents); the external provider answers 503 until a partner exists, never invented data |
| The server allocates berths (first free in class order) | the customer picks berths | how train booking works; and a simple, fair rule |
| Trip-row lock while allocating | rely on the unique index | measured: without the lock, everyone computes the same first free berth and only 3 of 10 sold; the index alone keeps it safe but not full |
| Random 10-digit PNR, UNIQUE, retried on a clash | a sequence | not guessable from another booking |

## Bus booking

| Decision | Rejected | Why |
|---|---|---|
| Its own module and tables (modules/bus, migration 016) | reuse events/orders | buses have seats, routes, dates and passengers; events have a stock count. Separate, a change to one can't break the other |
| Seats in PostgreSQL with a **unique index over active seats**, plus a trip-row lock | Redis Lua like the flash sale | a bus has ~40 seats and modest traffic: the database alone can guarantee it, simply. Measured: the index alone prevents double booking |
| One lock order: trip, then booking | lock what you touch | the deadlock found in event cancellation (bug log #3) |
| Expired holds freed by the next hold (and "taken" ignores run-out holds) | a background job | correct even when the worker isn't running |
| Confirm without payment for now | payment in the same step | smaller steps; payment is its own step for bus and train |

## Outside services (shared HTTP client)

| Decision | Rejected | Why |
|---|---|---|
| One client for outside services ([httpClient.js](../server/src/lib/httpClient.js)): a timeout on every call, clear 502/503/504 codes | a bare `fetch` in each module | a provider that hangs must not hang our API; the page must be able to say *what* failed |
| Retry only GET/HEAD (or a POST the caller marks idempotent), with exponential backoff and jitter | retry everything | a booking POST that timed out may have succeeded: retrying it could book twice |
| Log one line per failed attempt, never headers or bodies | log the request | headers carry credentials, bodies carry passenger data |
| A 4xx is returned to the caller, not thrown | treat every non-2xx as an error | "no such train" (404) is an answer the caller handles, not an outage |

## "Train server errors" (investigated 2026-11-27)

There was no train provider in the code: Train used the events API through Vite's proxy. Causes found: the API restarts on every server-file change (`node --watch`) and the proxy then answered a bare 500; Docker Desktop stopping (every database call fails); the background worker not running. Fixes: the proxy answers `502 API_UNREACHABLE` with a clear message, `/api/health` reports the worker, and the shared HTTP client for the coming train provider. **No public train-booking API exists:** IRCTC sells e-tickets only itself or through licensed agents/partners, so the train module will sell the platform's own inventory and plug in a licensed provider later, answering `503` until one is configured (never invented availability).

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

- Holds are lost if Redis loses its data.
- Lua scripts are single-Redis (no Cluster hash tags).
