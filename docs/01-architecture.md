# 01 · Architecture

## The big picture

```
                         development: one machine
 ┌──────────────┐  http://localhost:5173   ┌────────────────────┐   /api/*   ┌────────────────────────┐
 │   Browser     │ ───────────────────────► │  Vite dev server    │ ─────────► │  Express API  :5000     │
 │  React app    │ ◄─────────────────────── │  (serves React,     │  proxy     │  (Node.js)              │
 │               │   pages + JSON + cookies │   proxies /api)     │            │                        │
 └──────────────┘                           └────────────────────┘            └───────┬──────────┬─────┘
                                                                                      │          │
                                                                    SQL (pg pool, ≤10)│          │ commands + Lua (ioredis)
                                                                                      ▼          ▼
                                                                         ┌──────────────────┐ ┌──────────────────┐
                                                                         │ PostgreSQL 16     │ │ Redis 7           │
                                                                         │ THE TRUTH         │ │ FAST WORKING      │
                                                                         │ users, sessions,  │ │ MEMORY            │
                                                                         │ events, orders,   │ │ stock, holds,     │
                                                                         │ sold tickets…     │ │ revoked sessions, │
                                                                         │ (Docker volume)   │ │ rate limits…      │
                                                                         └──────────────────┘ └──────────────────┘
```

**The core principle:** PostgreSQL is the permanent record; Redis is fast, temporary working memory. **If they ever disagree, PostgreSQL wins**, and Redis is rebuilt from it (this is implemented for event stock and for revoked sessions).

**Why the Vite proxy matters:** the browser only ever talks to `localhost:5173`. Vite forwards `/api/*` to Express. To the browser, the page and the API have the **same origin**, so cookies "just work" (`SameSite=Strict`), and no CORS configuration is needed. In production the same effect is achieved by serving both from one domain.

## Why two databases?

| Need | PostgreSQL | Redis |
|---|---|---|
| Must never be lost (accounts, paid orders) | ✅ durable (written to disk, transactions, constraints) | ⚠️ in memory; can lose recent writes on a crash |
| Thousands of updates per second to ONE value (ticket stock in a flash sale) | ❌ row locks make everyone queue | ✅ single-threaded, microseconds per command |
| Data that should disappear by itself (revoked-session markers, rate-limit counters, sign-in attempts) | needs cleanup jobs | ✅ built-in expiry (TTL) |
| Rules the data must always obey (unique email, one owner per ticket) | ✅ constraints | ❌ |

So: **contended, short-lived state in Redis; durable truth in PostgreSQL.**

## Inside the API: the request life-cycle

Every request passes through the middleware chain in [server/src/app.js](../server/src/app.js), top to bottom:

```
request
  │
  ├─ trust proxy setting      decides what req.ip is (see 06-security: rate limiting)
  ├─ helmet()                 security headers on every response
  ├─ express.json({10kb})     parses JSON bodies; refuses bigger than 10 KB (413)
  ├─ cookieParser()           reads cookies into req.cookies (both tokens live in cookies)
  ├─ rejectCrossSiteRequests  CSRF guard for POST/PATCH/DELETE
  │
  ├─ /api/health    → health router
  ├─ /api/auth      → auth router         (rate limits + validate + authenticate per route)
  ├─ /api/admin     → authenticate → requireRole('admin') → admin router   (guard applied ONCE)
  ├─ /api           → events router       (/events…, /holds/…)
  │
  ├─ notFound                 nothing matched → 404 NOT_FOUND
  └─ errorHandler             ANY error thrown above ends here → one JSON error format
```

Express 5 forwards errors thrown in `async` handlers to `errorHandler` automatically, so no route needs `try/catch` boilerplate.

## Inside a module: four layers

Each feature (`auth`, `admin`, `events`) is split the same way:

```
xxx.routes.js      URL + which middleware run (rate limit, validate, authenticate) → controller
xxx.controller.js  HTTP only: read req.validated / req.user, call the service, write res (status, cookies, JSON)
xxx.service.js     the RULES. No req/res. Can be called from tests, scripts, other modules
xxx.repository.js  SQL only. No rules. Every query uses $1 placeholders (no SQL injection)
xxx.schemas.js     zod schemas describing valid input
```

Why: each layer can change without the others. The `set-role` command-line script, for example, calls the **same** admin service as the HTTP API, so the same rules apply to both.

`reservation/` is a little different: it is the low-level concurrency core (Redis + Lua) used by `events.service.js`.

## How errors flow

```
service:   throw new AppError(409, 'SOLD_OUT', 'Not enough tickets left (2 available)', { available: 2 })
             │
errorHandler: AppError → its status + { error: { code, message, details } }
              invalid JSON → 400 INVALID_JSON · body too big → 413 PAYLOAD_TOO_LARGE
              anything else (a bug) → logged on the server, client sees only 500 INTERNAL_ERROR
             │
frontend api/client.js: → ApiError { status, code, message, details, retryAfterSeconds }
             │
lib/errorMessages.js: code → a sentence for people
```

`code` is a stable contract for programs (the frontend switches on it); `message` is for humans and may be reworded.

## Startup and shutdown ([server/src/index.js](../server/src/index.js))

- **Startup:** reads and checks every setting (`config/env.js` — missing or weak secrets stop the server with a clear message), builds the app, starts listening, and copies recently revoked sessions from PostgreSQL into Redis (and again every time Redis reconnects).
- **Graceful shutdown:** on Ctrl+C (`SIGINT`) or a platform stop (`SIGTERM`), stop accepting new requests, let running ones finish, then close the PostgreSQL pool and the Redis connection.

## The health check

`GET /api/health` runs `SELECT 1` on PostgreSQL and `PING` on Redis **in parallel**, each with a 2-second timeout, and answers `200 { status: "ok" }` or `503 { status: "degraded" }` with which service is down. A hosting platform uses this to decide whether to send traffic to the server.
