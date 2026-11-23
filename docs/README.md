# Flash-Sale Ticketing System — Project Documentation

A ticketing platform built to stay **correct** (never sell a ticket twice) and **stable** when thousands of people try to buy at the same second. This folder explains **what has been built, what it is built with, and how every part works behind the scenes**.

> Built step by step as a learning project. Every decision, trade-off and test is recorded here, so each part can be explained in an interview.

---

## Contents

| # | Document | What it covers |
|---|---|---|
| — | **This page** | Status, how to run, all commands, folder map |
| 01 | [Architecture](01-architecture.md) | The big picture: browser → Vite → Express → PostgreSQL / Redis, request life-cycle, layers |
| 02 | [Tech stack](02-tech-stack.md) | Every tool and library, its version, and **why** it was chosen |
| 03 | [Data: PostgreSQL & Redis](03-data.md) | Every table, column and constraint; the migrations; every Redis key |
| 04 | [Authentication](04-authentication.md) | Register, login, password hashing, JWT, cookies, refresh rotation, reuse detection, sessions, logout, password reset |
| 05 | [Google sign-in](05-google-login.md) | OpenID Connect, PKCE, state, nonce, ID-token checks, account linking |
| 06 | [Security](06-security.md) | All defences in one place: CSRF, rate limiting, revocation, IDOR, timing attacks, validation, headers, fail open / fail closed |
| 07 | [Tickets & holds](07-tickets-and-holds.md) | The race condition, atomic Lua scripts, holds, events API, stock rebuild, clocks |
| 08 | [Frontend](08-frontend.md) | Pages, API client, automatic refresh, auth state, guards, countdowns |
| 09 | [API reference](09-api-reference.md) | Every endpoint, request, response and error code |
| 10 | [Testing](10-testing.md) | Every test file, how tests are isolated, mutation testing, flaky-test lessons |
| 11 | [Decisions log](11-decisions-log.md) | Every decision, the options rejected, and why; known limitations |
| 12 | [Orders & payments](12-orders-and-payments.md) | Checkout, idempotency keys, the fake provider, signed webhooks, ticket numbers, late payments, refunds |

---

## Status

Roadmap from the original blueprint. ✅ done · 🟡 partly done · ⬜ not started.

| Phase | What | Status |
|---|---|---|
| 0 | Setup: Docker Compose, project skeleton, database schema & migrations | ✅ |
| 1 | Correct core: race-condition demo, atomic stock (Lua), concurrency tests, **ticket holds**, events API, event pages | ✅ |
| Auth | (added before Phase 2) register/login, argon2id, JWT in HttpOnly cookies, refresh rotation + reuse detection, sessions, logout everywhere, Google sign-in, roles/admin, CSRF protection, rate limiting, password reset | ✅ |
| Frontend | React pages for everything above, with minimal styling (real styling comes in Phase 7) | ✅ |
| 2 | Orders & payment: holds → pending orders → (fake) payment → paid, idempotency, `sold_tickets` | ✅ (demo data · orders + idempotency · fake provider + signed webhook · failures, late payments, refunds logged · My orders page) |
| 3 | Expiry: a background worker (BullMQ) that releases expired holds for everyone | ⬜ (today: lazy expiry only — see [07](07-tickets-and-holds.md#what-is-not-automatic-yet)) |
| 4 | Waiting room: queue, admission worker, live position | ⬜ |
| 5 | Protection: rate limit on holds, duplicate-tab and bot defence | 🟡 (auth endpoints are rate-limited; holds are not yet) |
| 6 | Proof: k6 load tests with thousands of users, SQL verification | ⬜ |
| 7 | Polish: styling, Razorpay test mode, deployment, demo video | ⬜ |
| 8 | Stretch: numbered seats, multiple servers, metrics | ⬜ |

**Numbers today:** 205 server tests + 34 frontend tests, all passing. 300 signed-in users racing for 100 tickets over real HTTP → exactly 100 holds.

---

## How to run it

**Needs:** Node.js 20.6+ (developed on 24.13), Docker Desktop.

```powershell
docker compose up -d               # PostgreSQL 16 + Redis 7 (they restart by themselves after a reboot)
npm install                        # all packages, for server and client (npm workspaces)
copy server\.env.example server\.env
# then put a random secret in server\.env:
node -e "console.log(require('crypto').randomBytes(64).toString('base64url'))"
#   → paste it after JWT_ACCESS_SECRET=
npm run migrate                    # create the database tables
npm run dev                        # API on :5000 and React on :5173, together
```

Open **http://localhost:5173**. (The API alone is at http://localhost:5000/api/health.)

A fresh database has no events, so the ticket pages look empty. Add demo events with:
```powershell
npm run seed:demo
```

To use the admin pages, make yourself an admin and log in again:
```powershell
npm run set-role -- you@example.com admin
```

To try "Continue with Google", create an OAuth client in Google Cloud Console (type *Web application*, redirect URI `http://localhost:5173/api/auth/google/callback`) and put its id and secret in `server/.env` (`GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`). Without them, Google sign-in answers "not configured" and everything else works.

Emails (password reset) are **printed in the server terminal** in development.

---

## All commands (run from the project root)

| Command | What it does |
|---|---|
| `npm run dev` | Starts the API (`node --watch`, restarts on file changes) and the React dev server (Vite) together, via `concurrently` |
| `npm test` | Runs all server tests (Node's built-in test runner) **and** all frontend tests (Vitest). Needs Docker running |
| `npm run lint` | Checks the frontend code with ESLint |
| `npm run build` | Builds the frontend for production into `client/dist` |
| `npm start` | Starts the API without auto-restart |
| `npm run migrate` | Applies any new database migrations (safe to run any number of times) |
| `npm run demo:race` | The Phase 1 demo: 1,000 buyers vs 100 tickets, broken version vs the two fixes |
| `npm run set-role -- <email> <user\|admin>` | Gives or removes admin rights from the command line |
| `npm run seed:demo` | Creates three demo events (on sale now, almost sold out, on sale in 10 minutes). Safe to run again: existing ones are skipped |
| `docker compose up -d` / `docker compose down` | Start / stop PostgreSQL and Redis (data is kept in Docker volumes) |

---

## Folder map

```
TicketBooking/
├── docker-compose.yml        PostgreSQL 16 + Redis 7 (with health checks, volumes, auto-restart)
├── package.json              npm workspaces + the root commands above
├── docs/                     ← you are here
├── server/                   Express API
│   ├── .env.example          every setting, explained (copy to .env)
│   ├── .env.test             loaded only by `npm test` (switches rate limits off for the suite)
│   ├── migrations/           001 schema · 002 auth tables · 003 Google sign-in
│   ├── scripts/              race-demo.js · set-role.js
│   ├── src/
│   │   ├── index.js          starts the server, graceful shutdown, Redis revocation sync
│   │   ├── app.js            builds the Express app: middleware order + routes
│   │   ├── config/           env.js (all settings) · db.js (pool, transactions) · redis.js
│   │   ├── db/migrate.js     the migration runner
│   │   ├── lib/              errors · db-errors · mailer · rateLimiter (+ Lua)
│   │   ├── middleware/       validate · authenticate · authorize · csrf · errorHandler
│   │   ├── routes/health.js
│   │   └── modules/
│   │       ├── auth/         register, login, tokens, cookies, sessions, revocation, Google, reset, rate limits
│   │       ├── admin/        user list, role changes (and the admin "create event" route)
│   │       ├── events/       events + the HTTP side of holds
│   │       └── reservation/  stock counter + holds (Redis + Lua) — the concurrency core
│   ├── test/                 every server test (one file per area)
│   └── test-support/         test helpers (cookies, fake Google, bulk users, pooled HTTP client)
└── client/                   React app (Vite)
    └── src/
        ├── App.jsx           the routes
        ├── api/              the ONLY code that calls fetch(): client.js + one file per area
        ├── auth/             AuthProvider (who is signed in), useAuth, route guards
        ├── components/       Layout (nav), FormField, Alert, GoogleButton
        ├── hooks/            useCountdown
        ├── lib/              error messages, validation, formatting, server clock
        └── pages/            one file per page
```

---

## Git history

Every step is its own commit (Conventional Commits style: `feat:`, `test:`, `chore:`). `git log --oneline` tells the story of the project from the starter template to today.
