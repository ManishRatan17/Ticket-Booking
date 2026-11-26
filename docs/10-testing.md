# 10 · Testing

```powershell
docker compose up -d     # the server tests use the real PostgreSQL and Redis
npm test                 # server (node:test) then client (Vitest)
```

Today: **383 server tests + 42 client tests**, all passing, none skipped.

## Their own database, and CI

**Tests never touch development data.** [server/.env.test](../server/.env.test) points them at the database `ticketing_test` (same PostgreSQL container) and at **Redis database 1** (development uses 0). Before every run, `npm test` runs [scripts/prepare-test-db.js](../server/scripts/prepare-test-db.js) (the `pretest` script): it creates the test database if needed and migrates it. It refuses any database whose name doesn't contain "test". Real outside services (Razorpay, Resend) are switched off in `.env.test` whatever `server/.env` says; their tests use fakes.

Why: while tests shared the development database, a real admin made the 3 "last admin" tests **skip**, 10,000 load-test users pushed a test's admin off a page, and interrupted runs left test users behind. Now: **0 skipped**.

Test files start 4 at a time; on a fresh database they'd all migrate at once. The migration runner takes a PostgreSQL **advisory lock**: one migrates, the others wait and find nothing to do (the same protects deployments with several servers starting together).

**CI:** [.github/workflows/test.yml](../.github/workflows/test.yml) runs on every push and pull request. A fresh Ubuntu machine gets PostgreSQL 16 and Redis 7 (service containers), runs `npm ci`, lint, **all tests** and the build. A JWT secret is made fresh for each run. The README's badge shows the latest result.

## How the server tests run

`npm test -w server` = `node --env-file-if-exists=.env --env-file-if-exists=.env.test --test --test-concurrency=4 --test-timeout=60000`

| Flag / file | Why |
|---|---|
| `--env-file .env` then `.env.test` | the last file wins: [.env.test](../server/.env.test) switches rate limits **off** for the suite (hundreds of requests from one IP would trip them). The rate-limit tests switch them back on for their own process |
| `--test` | Node's built-in runner; every `.js` file in `test/` is a test file, each in its **own process** |
| `--test-concurrency=4` | at most 4 files at once. All files in parallel made CPU-heavy argon2 + bursts delay new database connections past the 2-second timeout (a flaky failure, 1 in 4 runs) |
| `.env.test`: `JOBS_ENABLED=false` | the suite creates hundreds of holds; without a worker their delayed jobs would pile up in Redis. `jobs.test.js` switches jobs back on with its own queue prefix and deletes its queue at the end |
| `--test-timeout=60000` | a test that hangs (e.g. Docker stopped and ioredis retries forever) **fails** after 60 s instead of hanging the whole run |

## Isolation: tests leave no trace

- Every file uses a random run prefix (`test-login-3fa9…`) for emails, event names and Redis keys, and deletes exactly those at the end.
- Schema tests run inside `BEGIN … ROLLBACK`.
- Rate-limit tests use their own Redis key prefix.
- Tests run against their **own** database and Redis database (above), never the development data.

## Test helpers ([server/test-support/](../server/test-support/))

Kept outside `test/` because Node runs every file inside `test/` as a test.

| Helper | What it does |
|---|---|
| [cookies.js](../server/test-support/cookies.js) | read `Set-Cookie`, build `Cookie` headers, list flags (Node's `fetch` has no cookie jar) |
| [fake-google.js](../server/test-support/fake-google.js) | a fake OpenID provider: RSA keys, JWKS, codes, PKCE check, signed ID tokens |
| [admin-lock.js](../server/test-support/admin-lock.js) | a PostgreSQL **advisory lock** so the "last admin" tests run only when no other test file has admin users: files that create admins hold it shared, the last-admin tests take it exclusive. (Found when the dev database lost its own admin: the tests stopped skipping and then failed in the full parallel run, because another file's admin appeared mid-test. Alone, they passed.) |
| [fake-razorpay.js](../server/test-support/fake-razorpay.js) | a fake Razorpay: creates orders (checks Basic auth), produces the checkout window's signed answer, and signed webhook deliveries |
| [fake-turnstile.js](../server/test-support/fake-turnstile.js) | a fake Cloudflare `siteverify`: checks the secret, single-use `human-…` tokens, records every call, and can answer 500 or drop the connection |
| [users.js](../server/test-support/users.js) | creates hundreds of signed-in users fast (user + session rows + tokens signed by the real code) without 300 argon2 logins |
| [redis-cleanup.js](../server/test-support/redis-cleanup.js) | `deleteEventKeys(ids)`: removes a test's stock keys, holds, user links and expiry-index entries in one place (replaced 7 hand-written copies; one of them forgot hold keys and left hundreds of stale holds in the dev Redis) |
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
| `orders.test.js` | hold → pending order, price from the database (body can't set it), **idempotency** (replay, 10 parallel same-key → 1 order, **30 rounds × 20 truly simultaneous same-key calls → always the same order, never `ORDER_EXISTS`**, other key → 409, key reuse → 422, missing key → 400), IDOR, expired hold, lazy order expiry, the `tickets_sold` CHECK |
| `payments.test.js` | pay → signed webhook → paid with ticket numbers; failed payment; the browser can't decide payment; wrong secret / tampered body → 401; duplicates (sequential and 10 at once); two deliveries for one order; amount mismatch; late payment (free → paid, sold out → refund); 20 simultaneous payments → numbers 1–20 |
| `jobs.test.js` | a real worker inside the test process, 1-second holds (`HOLD_SECONDS=1`), private queue prefix: the job is scheduled with retry/dead-letter settings; an **abandoned** hold is released with nobody looking; an unpaid order becomes `expired`; a paid hold is left alone; the job is idempotent (3 runs at once → tickets back once); a job that runs too early fails and changes nothing |
| `sweep.test.js` | the expiry index is maintained on create / release / pay and rebuilt by `indexAllHolds()`; the sweep releases an expired hold that never got a job, leaves running holds alone, expires an overdue order whose hold vanished, removes stale index entries, and two sweeps at once release each hold once |
| `admin-jobs.test.js` | admin-only (403/401); overview has counts for every state, ≥ 1 worker, the 60-s sweep schedule; **the dead-letter flow**: a job fails its only attempt → listed with its error → cause fixed → Retry → completed, tickets back; retry of an unknown job → 404, of a job that hasn't failed → 409 |
| `waiting-room.test.js` | no pass → 403; events without a room unchanged; arrival order and keeping your place on re-join; **300 simultaneous joins → positions 1–300**; N per tick in order; pass lasts 10 min and allows holding; the lobby (queue before the sale, no admission); **fairness under load** (300 people, 6 ticks, nobody overtakes); two admission runs at once never admit anyone twice; lobby window (too early → 409 `LOBBY_NOT_OPEN`, nobody added; per-event `lobbyMinutes`; schema 1–1440, default 15); **fair draw**: 200 joining the lobby one by one get places 1–200 unrelated to arrival order (rank correlation ≈ 0), admission follows the draw, newcomers after the sale queue behind the lobby, re-joining never re-draws; statuses carry `ticketsLeft` / `buyersLeft` / `chance` and follow the stock; **all held → admission pauses** and resumes when tickets come back; every ticket paid → `sold_out` for everyone |
| `waiting-room-stream.test.js` | reads the raw SSE stream: correct content type; first message = current status; position updates live as people ahead are admitted, then `admitted` and the stream ends; 401 / 409 as plain JSON; Phase 5c: 3 streams per user, the 4th → JSON 429 (not counted), closing a tab frees a slot, key deleted at 0, **10 tabs at once → exactly 3 streams**, an admitted stream gives its slot back; sold out for good → the stream says so and ends |
| `ticket-rate-limits.test.js` | Phase 5a, limits switched on with a private prefix: 11th hold → 429 + `Retry-After`, others on the same IP unaffected; **13 accounts × 10 holds from one IP at once → exactly 10 refused**; release, join, status, orders and payments limits; anonymous floods don't use anyone's budget |
| `purchase-limit.test.js` | Phase 5b: bought 4 → 1 more refused with `{ bought, limit }`; bought 2 → 3 refused without touching stock, 2 fine; per person and per event; failed payments don't count; `purchase` in my-hold; Redis loses the count → rebuilt from PostgreSQL; **two orders paid at once → exactly 4 tickets** |
| `bot-check.test.js` | Phase 5d against the fake Cloudflare: `/api/config` has the site key, not the secret; no / made-up / **replayed** token → 403; good token → 201 with secret, token and visitor IP sent; a typo doesn't use up the token; honeypot → 403, no account; Cloudflare 500 / dropped connection → allowed (fail open); wrong secret → refused; queue join needs a token; 401 before any Cloudflare call |
| `chance.test.js` | the waiting room's "what are my chances?" levels: exact boundaries (0.7 and 1.3 × buyers left), lobby shares, rounding, no estimate outside the line, `all_held` / `sold_out` for every status |
| `lucky-draw-pool.test.js` | the lucky draw's own pool: 20 % of 1,000 → 800 + 200; schema limits; the normal sale can't touch the draw's tickets; a winner holds from the lucky pool (limit per winner); released and expired lucky tickets return to the lucky pool, even when replaced by a normal hold; orders keep their pool; both pools rebuilt from PostgreSQL |
| `lucky-draw.test.js` | the draw: fingerprint public / seed secret before; nothing before the draw time; round 1 = exactly the lowest draw numbers, verifiable from the revealed seed; winners' lucky passes; two jobs at once → one round; round 2 waits a full round and picks the next numbers, nobody twice; people at the 4-ticket limit skipped; closing returns leftovers (and later releases) to the normal sale; empty draw; **chi-square fairness over 2,000 seeds**; someone admitted but still in the draw keeps the live stream and sees the win arrive |
| `support.test.js` | the support inbox: request + first message, validation, one open request per kind and event, IDOR → 404, admin-only → 403, the conversation, **approved +2 → limit 6 for holds and payments** (only that person and event), declined, decided once, **two admins at once → one wins**, questions closed not approved, deleting an event keeps the conversation |
| `bot-strikes.test.js` | Phase 5e with rate limits, the bot check and moderation on (private prefixes, fake Cloudflare): normal use → no signal; **a shared IP never gets anyone a signal**; a script → suspended 15 days with evidence; cleanup after a strike and booking blocked everywhere; restricted people can still sign in and use the support inbox; missing / fake tokens; second strike → banned; old or overturned strikes don't count; a suspension ends by itself; two strikes at once → one; appeals; admin restrict / lift; login returns the restriction |
| `short-cache.test.js` | the in-memory cache for hot data (Phase 6): **1,000 simultaneous misses → ONE query** (single-flight), reuse within the time limit, delete, failures not cached, off at 0 |
| `admin-console.test.js` | admins can't buy (hold, join, order, pay → 403) or send support requests; Manage events live numbers and statuses; editing before / after the sale; a lucky draw keeps its waiting room; admins only; bot-strike notifications with the email, hand-made restrictions not "new", mark as seen |
| `website.test.js` | the API serving the built website (Phase 7): pages → index.html, `/api` stays JSON (JSON 404), year-long caching of built files, the security policy |
| `mail.test.js` | real email against a fake Resend: the request it receives, a 500 makes delivery fail (so the job retries), `sendMail` queues a `send-email` job that isn't kept after delivery |
| `razorpay.test.js` | Razorpay test mode against a fake Razorpay: public key only, fake provider off, one Razorpay order for the exact amount, a valid signature pays (once), a forged signature or another order's payment → 400, the webhook alone pays, page + webhook at once → tickets once, a failed attempt keeps the order payable, webhook signature / duplicates / unknown orders, a wrong amount fails |
| `refunds.test.js` | money that bought no tickets goes back: recorded with the payment, refunded, emailed, shown in the order; one refund per payment; a wrong amount → the paid amount back; admin list and Retry |
| `audit.test.js` | the admin audit log: a role change (which admin, their email, whom, the role), creating + editing an event (the new event's id as the target), failed actions and reads NOT recorded, a set-role change recorded as "command line", **the database refuses UPDATE and DELETE**, admins read it (newest first, filter), normal users → 403 |
| `cancel-event.test.js` | cancelling an event: paid orders cancelled + refunded + emailed, unpaid ones ended, holds / orders / the queue → 409, the shop and admin show it; twice, unknown, short reason, no edits, admins only, audited; a payment for an order that slipped in → refunded; **8 payments racing the cancel (3 rounds)** → one refund each, nothing paid, no deadlock; the waiting room emptied |
| `housekeeping.test.js` | the daily cleanup removes long-dead sessions (and their refresh tokens), stale reset links and old webhook records, and keeps living sessions, recently logged-out ones, fresh links and recent webhooks |
| `holds-http.test.js` | the holds API: every status code, IDOR, CSRF, lazy release on read, **300 users × 100 tickets over HTTP** |

## Client test files (Vitest)

| File | What it proves |
|---|---|
| `api/client.test.js` | refresh-and-retry, single shared refresh, 409 handling, session-over codes, retry only once, wrong password not refreshed, error parsing, `Retry-After` |
| `lib/format.test.js` | device names from real user-agent strings, "time ago" |
| `lib/serverClock.test.js` | countdowns correct with the device clock fast or slow; formatting |
| `api/admin.test.js` | "create event" sends every form field (it used to send only 3: price, waiting room, lobby and lucky draw were silently dropped) |
| `lib/verifyDraw.test.js` | the browser's draw check (Web Crypto) computes exactly what the server computes (node:crypto); a swapped seed or another person's number fails |
| `api/botCheck.test.js` | the "are you a person?" token goes in `X-Turnstile-Token` (register and queue join); no header without a token; the honeypot field is sent only when filled |

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
| worker never releases the hold | 3 job tests |
| hold API never schedules the job | 3 job tests (the abandoned hold stays held) |
| new holds not added to the expiry index | the index test |
| re-joining the queue gives a new (later) place | the keep-your-place test |
| holds allowed without a waiting-room pass | the NOT_ADMITTED test |
| lobby window check removed from `join-queue.lua` | the too-early test |
| lobby joiners given arrival numbers instead of the random draw | the fair-draw test (rank correlation 1.000) and the re-draw test |
| chance level "good" never given in line | 4 chance tests |
| admission pause (stock 0) removed | the all-held test |
| `release-hold.lua` always returning tickets to the normal stock | the lucky-pool release test |
| lucky-draw winners chosen by user id instead of draw number | 3 draw tests |
| no wait between lucky-draw rounds | the round-2 test and the two-jobs test |
| stream ends on admission even while waiting for a draw | the live-win test |
| support approval without raising the limit | 2 support tests |
| orders: hold-index clash answered `ORDER_EXISTS` even for the SAME key (the old code) | the 30 × 20 service-level race, 2/2 runs |
| restriction check removed from the hold route | 3 strike tests |
| sold-out fast path ignoring the person's own (expired) hold | the fast-path test |
| "admins can't buy" removed from the hold route | the admin-booking test |
| the admin email alert after an automatic strike removed | the email test |
| Razorpay: payment not checked against THIS order / any signature accepted | the forged-payment test (both) |
| refund without first asking Razorpay whether it already happened | the lost-answer test (money sent back twice) |
| "already restricted" guard removed from `strike()` | the two-strikes-at-once test |
| payment check ignoring a raised limit | the approval test |
| client createEvent sending only name/tickets/sale time (the old code) | the client createEvent test |
| hold rate limiters (per user and per IP) removed | both hold rate-limit tests |
| audit middleware removed from the admin mount | 3 audit tests (role change, event create/edit, reading the log) |
| holds not checking whether the event was cancelled | the cancel test (a hold → 200) |
| the payment ignoring a cancelled event | the slipped-in-order test (tickets for a cancelled event) |
| the cancel locking the event row first (the opposite order to payments) | the race test: "deadlock detected", 3 of 3 runs |
| purchase-cap check removed from `create-hold.lua` | the hold-refused tests |
| purchase-cap check removed from the payment transaction | the simultaneous-payments test (8 tickets paid) |
| stream cap removed from `stream-open.lua` | 2 stream-cap tests |
| stream slot never given back | 3 stream-cap tests |
| `requireHuman` removed from register | 5 bot-check tests |
| honeypot check disabled | the honeypot test |

## Load tests

Thousands of users are tested separately, with k6 and SQL verification afterwards: see [19-load-testing.md](19-load-testing.md). Note: while a load test's 10,000 people are in the database, `admin lists users` can fail (its admin is pushed off the first page). Run `loadtest/cleanup.mjs` before the test suite.

## Lessons from flaky and broken runs

- **A test that failed once in a full run (orders, same-key race):** it passed 5/5 alone, so it would have been easy to call it "flaky". A stress script (60 rounds × 20 simultaneous calls) reproduced it every time: ~15 errors in 1,200, a real bug since Phase 2 (see [12](12-orders-and-payments.md#orders-and-idempotency-step-2a)). Lesson: a rare failure under load is usually a real race; make it frequent, then fix it.

- **A failing race test that left data behind (cancel an event):** while checking that the race test catches a deadlock, each failed run left users and paid orders in the test database. The test failed as soon as the cancel deadlocked, but its 8 payments were still running; the cleanup ran under them, and tickets written afterwards blocked the deletes. 9 runs later, the leftover admins made the 3 "last admin" tests **skip** and pushed another test's admin off a 100-user page (**fail**). Fix: `Promise.allSettled`, so the test waits for every payment before it fails. Lesson: a test must finish its own work before failing, or its cleanup races it.

- **A test file that never ends (support inbox):** all 10 tests passed, then the file hung. Its cleanup threw (a real bug: deleting an event broke a table rule on its support requests) before releasing the admin lock and closing connections, so the process never exited. Fixes: the rule (see [17](17-support-inbox.md)), and cleanup in `try … finally`. Lesson: a hanging run often hides an error in `after()`; run the file with `--test-reporter=spec` into a file to see it.

| Symptom | Real cause | Fix |
|---|---|---|
| 7 schema tests failed 1 run in 4 (connection timeout) | too many test files in parallel → CPU starvation | `--test-concurrency=4` |
| whole suite hung 400 s | Docker restarted; ioredis retried forever | `restart: unless-stopped`, `--test-timeout` |
| "expires in 300.001 s" failed 1 run in 3 | Redis clock (Docker) vs Windows clock ≈ 1 ms apart | test tolerance; the code compares Redis time with Redis time only |
| `ECONNREFUSED` in the 300-user race | Windows refuses ~68 of 300 simultaneous new local connections | pooled HTTP client |
| a manual check "missing" an email | the check script killed the servers before output reached the log | wait before stopping; verify with the database |
| a manual check where every call failed | the script didn't wait for Express (Vite answered 502 meanwhile) | wait with `curl -f` |
| manual registrations refused | the real register limit (5/hour from 127.0.0.1) | create manual-test users directly in the database |
| a live check of the worker failed although all tests passed | leftover `npm run dev` trees from earlier checks: `node --watch` restarts its child, so killing only the port's process left an old server (without the test's settings) answering | stop the **whole process tree** (`taskkill /T`); first check which process actually serves the port |
| the first sweep test took 6 s and missed its hold | hundreds of stale holds from a test cleanup that didn't delete hold keys; one batch of 500 didn't reach the test's hold | the sweep loops until done; one shared cleanup helper |
| `jobs.test.js` failed after adding the cleanup helper | a normal `import` is hoisted, so the helper loaded `env.js` before the test applied its settings | dynamic `await import()` in that file |
| 1 test failed in 2 of 3 full runs, a different one each time (Phase 4) | `admitWaiting()` admits people in EVERY active room, so one test file's admission ticks admitted people in another file's rooms; a development worker would do the same | waiting-room keys get a prefix (`test-wr` in `.env.test`), and tests call `admitWaiting({ eventIds })` for their own rooms only. Also: the commit before this fix (`66eca00`) was pushed with that failure — the command chained steps with `;`, so it continued after `npm test` failed. Now: tests first, and stop on any failure |
| `register.test.js` stopped mid-file once under the full parallel suite | **not explained yet**: didn't recur in 3 full runs and 4 single runs; watch for it | — |
| "An Application Control policy has blocked this file" once | Windows security re-checking a native file just after Docker restarted (unproven) | didn't recur; oxlint (always blocked) was replaced by ESLint |
