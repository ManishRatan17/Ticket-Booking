# 10 · Testing

```powershell
docker compose up -d     # the server tests use the real PostgreSQL and Redis
npm test                 # server (node:test) then client (Vitest)
```

Today: **205 server tests + 34 client tests**, all passing (about 10–15 s for the server suite).

## How the server tests run

`npm test -w server` = `node --env-file-if-exists=.env --env-file-if-exists=.env.test --test --test-concurrency=4 --test-timeout=60000`

| Flag / file | Why |
|---|---|
| `--env-file .env` then `.env.test` | the last file wins: [.env.test](../server/.env.test) switches rate limits **off** for the suite (hundreds of requests from one IP would trip them). The rate-limit tests switch them back on for their own process |
| `--test` | Node's built-in runner; every `.js` file in `test/` is a test file, each in its **own process** |
| `--test-concurrency=4` | at most 4 files at once. All files in parallel made CPU-heavy argon2 + bursts delay new database connections past the 2-second timeout (a flaky failure, 1 in 4 runs) |
| `--test-timeout=60000` | a test that hangs (e.g. Docker stopped and ioredis retries forever) **fails** after 60 s instead of hanging the whole run |

## Isolation: tests leave no trace

- Every file uses a random run prefix (`test-login-3fa9…`) for emails, event names and Redis keys, and deletes exactly those at the end.
- Schema tests run inside `BEGIN … ROLLBACK`.
- Rate-limit tests use their own Redis key prefix.
- Tests run against the **development database**. One consequence: the "last admin" tests **skip** (with a message) if real admins exist. A separate test database is on the to-do list.

## Test helpers ([server/test-support/](../server/test-support/))

Kept outside `test/` because Node runs every file inside `test/` as a test.

| Helper | What it does |
|---|---|
| [cookies.js](../server/test-support/cookies.js) | read `Set-Cookie`, build `Cookie` headers, list flags (Node's `fetch` has no cookie jar) |
| [fake-google.js](../server/test-support/fake-google.js) | a fake OpenID provider: RSA keys, JWKS, codes, PKCE check, signed ID tokens |
| [users.js](../server/test-support/users.js) | creates hundreds of signed-in users fast (user + session rows + tokens signed by the real code) without 300 argon2 logins |
| [pooled-http.js](../server/test-support/pooled-http.js) | HTTP client with a connection pool. On Windows, 300 brand-new simultaneous connections to a local port get ~68 refused by the OS (measured; not affected by the server's backlog). A pool of 50 keep-alive connections gets all 300 requests through — still a real race |

## Server test files

| File | What it proves |
|---|---|
| `health.test.js` | health endpoint reports both databases |
| `foundations.test.js` | error format, validation (normalise, strip unknown fields), invalid JSON, 10 KB limit, no leaked internals, helmet headers |
| `schema.test.js` | the database refuses bad data: duplicate ticket, duplicate idempotency key, bad status/role, uppercase email, cascades |
| `stock.test.js` | Phase 1: 1,000 buyers × 100 tickets (5 rounds), mixed quantities (conservation, no false refusals), and **the naive version oversells** (proves the test can see a race) |
| `password.test.js` | argon2id settings, salts, Unicode normalisation, re-hash detection, common passwords, timing |
| `register.test.js` | normalisation, no hash leaked, duplicates (incl. 20 parallel), mass assignment, every validation error |
| `login.test.js` | token structure, identical errors, **timing** (unknown ≈ wrong password), re-hash, 8 forged/expired/tampered tokens, cookies only, secret checks at startup |
| `refresh.test.js` | cookie flags, hashes only, rotation chain, **10 parallel refreshes → 1 winner**, reuse revokes the session, expiry rules |
| `google.test.js` | the whole OIDC flow against the fake provider: state, single use, login CSRF, PKCE, 5 bad ID tokens, unverified email, the four linking cases |
| `sessions.test.js` | logout is instant (Redis), idempotent, logout-all, session list, IDOR, reuse kills access tokens, rebuild after Redis loses keys |
| `admin.test.js` | 401 vs 403, listing/paging, promotion at refresh, **instant demotion**, last admin, races (HTTP and 10-round service level), the `set-role` script |
| `csrf.test.js` | blocked and allowed headers, GET never blocked, the real attack |
| `rate-limit.test.js` | Lua counter atomicity + expiry, login limits (incl. 20 parallel guesses → 5), attacker locks only themselves out, every endpoint's limit, headers |
| `password-reset.test.js` | link in `#fragment`, identical answers, no waiting for email, newest link only, single use, race, expiry, rollback on "password = email", sessions revoked, Google-only users |
| `holds.test.js` | holds in Redis: rules, lazy expiry, idempotent release, owner check, 1,000-user race, mixed quantities, 50 clicks → 1 hold |
| `events.test.js` | admin creation, reading, validation, **stock rebuilt from PostgreSQL**, rebuild race (`SET NX`) |
| `orders.test.js` | hold → pending order, price from the database (body can't set it), **idempotency** (replay, 10 parallel same-key → 1 order, other key → 409, key reuse → 422, missing key → 400), IDOR, expired hold, lazy order expiry, the `tickets_sold` CHECK |
| `payments.test.js` | pay → signed webhook → paid with ticket numbers; failed payment; the browser can't decide payment; wrong secret / tampered body → 401; duplicates (sequential and 10 at once); two deliveries for one order; amount mismatch; late payment (free → paid, sold out → refund); 20 simultaneous payments → numbers 1–20 |
| `holds-http.test.js` | the holds API: every status code, IDOR, CSRF, lazy release on read, **300 users × 100 tickets over HTTP** |

## Client test files (Vitest)

| File | What it proves |
|---|---|
| `api/client.test.js` | refresh-and-retry, single shared refresh, 409 handling, session-over codes, retry only once, wrong password not refreshed, error parsing, `Retry-After` |
| `lib/format.test.js` | device names from real user-agent strings, "time ago" |
| `lib/serverClock.test.js` | countdowns correct with the device clock fast or slow; formatting |

## Mutation testing

A test only proves something once it has been seen to **fail for the right reason**. For each important protection, the code was deliberately broken, the tests run, and the code restored:

| Mutation | Caught by |
|---|---|
| Lua stock check → `if false` | 3 stock tests |
| dummy-hash timing protection removed | login timing test (4 ms vs 42 ms) |
| `AND used_at IS NULL` removed from the refresh claim | 10 parallel refreshes → all 200 |
| Google `nonce` check / `aud` check removed | exactly the matching ID-token test |
| Redis revocation check removed from `authenticate` | 5 session tests |
| `requireRole` removed from the admin mount | 3 admin tests |
| admin row lock removed | ✗ the HTTP race test **still passed** → too gentle → a service-level 10-round race was added, which fails in round 1 |
| CSRF guard removed | 5 CSRF tests |
| `EXPIRE` removed from the rate-limit script | TTL −1 ("blocked forever") |
| per-email login limiter removed | 3 rate-limit tests |
| reset single-use check removed / reset session revocation removed | 3 tests / 1 test |
| one-hold-per-user check removed | 2 hold tests |
| release forgets to delete the hold | idempotent-release tests |
| stock check removed, seen **through HTTP** | the 300-user race |
| server sale-start check removed | `SALE_NOT_STARTED` test |
| stock rebuild without `NX` | rebuild race, 3/3 runs |
| client: session-over 401s not reported | the `SESSION_REVOKED` client test |
| order insert without `ON CONFLICT DO NOTHING` | the 10-parallel idempotency race |
| paid hold RELEASED instead of consumed | 2 payment tests (stock went back up: an oversell) |
| duplicate-webhook check removed | the sequential duplicate test (the parallel one still passed thanks to the order lock — two independent layers) |
| any webhook signature accepted | both signature tests |

## Lessons from flaky and broken runs

| Symptom | Real cause | Fix |
|---|---|---|
| 7 schema tests failed 1 run in 4 (connection timeout) | too many test files in parallel → CPU starvation | `--test-concurrency=4` |
| whole suite hung 400 s | Docker restarted; ioredis retried forever | `restart: unless-stopped`, `--test-timeout` |
| "expires in 300.001 s" failed 1 run in 3 | Redis clock (Docker) vs Windows clock ≈ 1 ms apart | test tolerance; the code compares Redis time with Redis time only |
| `ECONNREFUSED` in the 300-user race | Windows refuses ~68 of 300 simultaneous new local connections | pooled HTTP client |
| a manual check "missing" an email | the check script killed the servers before output reached the log | wait before stopping; verify with the database |
| a manual check where every call failed | the script didn't wait for Express (Vite answered 502 meanwhile) | wait with `curl -f` |
| manual registrations refused | the real register limit (5/hour from 127.0.0.1) | create manual-test users directly in the database |
| "An Application Control policy has blocked this file" once | Windows security re-checking a native file just after Docker restarted (unproven) | didn't recur; oxlint (always blocked) was replaced by ESLint |
