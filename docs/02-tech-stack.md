# 02 · Tech stack

Versions are the ones installed today (`package.json` allows newer minor versions).

## Runtime & infrastructure

| Tool | Version | Used for | Why this one |
|---|---|---|---|
| **Node.js** | 24.13 (needs ≥ 20.6) | Runs the API and all tooling | One language for server and client. Built-in test runner, `--watch`, `--env-file`, `fetch` |
| **PostgreSQL** | 16.16 (Docker image `postgres:16-alpine`) | Permanent data | Transactions and constraints: the database itself refuses a double-sold ticket |
| **Redis** | 7.4 (`redis:7-alpine`, append-only file on) | Stock, holds, revoked sessions, rate limits, sign-in attempts | Single-threaded → atomic commands; Lua scripts; key expiry; microsecond speed |
| **Docker Compose** | Docker Desktop | Runs PostgreSQL + Redis with one command | Same versions on every machine; health checks; data in volumes; `restart: unless-stopped` |
| **npm workspaces** | npm 11 | One repo, two packages (`server`, `client`) | One `npm install`, root commands for both |
| **concurrently** | 10.0.7 | `npm run dev` starts API + Vite together | Colour-labelled output of both |

## Server packages ([server/package.json](../server/package.json))

| Package | Version | Used for | Why / notes |
|---|---|---|---|
| **express** | 5.3.0 | HTTP server, routing, middleware | Familiar; v5 forwards errors from `async` handlers automatically |
| **pg** | 8.23.1 | PostgreSQL client with a connection **pool** (max 10, 2 s connect timeout) | Plain SQL — teaches SQL instead of hiding it behind an ORM |
| **ioredis** | 6.0.0 | Redis client; `defineCommand` loads Lua scripts once and calls them by hash (`EVALSHA`) | Also the client BullMQ (Phase 3) is built on |
| **argon2** | 0.45.2 | Password hashing (argon2id) | OWASP's first recommendation; memory-hard (resists GPU cracking). Uses its **prebuilt** binary — its install script (compile from C) is **denied** in root `package.json` → `allowScripts` |
| **jose** | 6.2.17 | Signing/verifying JWTs (HS256 for our tokens, RS256 + JWKS for Google's) | Modern, maintained, no dependencies, promise-based |
| **zod** | 4.6.7 | Validating and cleaning every request body / query / URL parameter | Strips unknown fields (stops mass assignment), normalises (trim, lowercase), precise error lists |
| **helmet** | 8.3.0 | Security response headers | One line for a set of browser protections |
| **cookie-parser** | 1.4.7 | Reads cookies into `req.cookies` | Both tokens live in cookies |

Node built-ins used heavily: `node:crypto` (random tokens, SHA-256, `timingSafeEqual`), `node:test` + `node:assert` (all server tests), `node:child_process` (tests that start a second process), `node:http` (pooled test client).

## Client packages ([client/package.json](../client/package.json))

| Package | Version | Used for | Why / notes |
|---|---|---|---|
| **react** / **react-dom** | 19.3.1 | The user interface | Simple, widely used |
| **react-router-dom** | 7.18.6 | Pages with real URLs (`/login`, `/events/7`, `/admin/users`) | Standard router; back button and links work |
| **vite** | 8.3.8 | Dev server (with the `/api` proxy) and production build | Fast; the proxy gives same-origin cookies in development |
| **vitest** | 5.1.1 | Frontend unit tests | Same config as Vite; runs on this Windows machine |
| **eslint** + `@eslint/js`, `eslint-plugin-react-hooks`, `eslint-plugin-react-refresh`, `globals` | 10.15.0 | Linting | Replaced **oxlint**: Windows *Application Control* blocks oxlint's unsigned native binary on this PC; ESLint is plain JavaScript. The React Hooks rules caught two real issues (`setState` inside effects) |

## Tools outside the code

| Tool | Used for |
|---|---|
| Git + GitHub | Version control: one commit per step, pushed to `github.com/ManishRatan17/Ticket-Booking` |
| Postman | Trying endpoints by hand (cookies: see `COOKIE_SECURE` in [06-security](06-security.md#cookies)) |
| `docker exec … psql` / `redis-cli` | Looking inside the databases |
| Google Cloud Console | The OAuth client for "Continue with Google" |

## Planned (not installed yet)

| Tool | Phase | For |
|---|---|---|
| BullMQ | 3 | Background jobs: releasing expired holds, sending emails reliably |
| Socket.IO or Server-Sent Events | 4 | Live waiting-room position |
| k6 | 6 | Load tests with thousands of virtual users |
| Razorpay (test mode) | 7 | Realistic payment flow |
| A real email provider (Resend / SES / SMTP) | 7 | Replaces the console mailer |
