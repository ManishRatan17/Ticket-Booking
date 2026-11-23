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
- A stray file from a mistyped command was committed in `85b42e8` (`- error handling, …`, the `less` pager's help text) — to be removed.
