# 03 · Data: PostgreSQL and Redis

## PostgreSQL — the permanent record

### Migrations

The database structure lives in numbered SQL files in [server/migrations/](../server/migrations/), applied by [server/src/db/migrate.js](../server/src/db/migrate.js) (`npm run migrate`):

1. Creates a bookkeeping table `schema_migrations (name, applied_at)` if missing.
2. For each `.sql` file **not yet recorded there**, in name order: `BEGIN` → run the file → record its name → `COMMIT`. Any error → `ROLLBACK` (the whole file or nothing).
3. Running it again does nothing new — it is **idempotent**.

**Rule:** an applied migration is never edited. Changes go in a new file (`002`, `003`, …) using `ALTER TABLE`. That's how 002 added roles and 003 made `password_hash` optional — without losing data.

| File | What it does |
|---|---|
| `001_initial_schema.sql` | `users`, `events`, `orders`, `sold_tickets`, `processed_webhooks` |
| `002_auth.sql` | users get `role`, `password_changed_at`, lowercase-email check; new `sessions`, `refresh_tokens`, `password_reset_tokens` |
| `003_google_login.sql` | `password_hash` becomes optional; users get `email_verified_at`; new `user_identities`; new revoke reason `account_linked` |
| `005_waiting_room.sql` | events get `admission_per_second` (NULL = no waiting room) |
| `004_orders_payments.sql` | events get `price_paise` and `tickets_sold` (with `CHECK tickets_sold BETWEEN 0 AND total_tickets`); orders get `hold_id` (unique), `amount_paise`, `paid_at`, `failure_reason` |

### Tables

#### `users`
| Column | Type | Rules / meaning |
|---|---|---|
| `id` | BIGINT identity | primary key |
| `email` | TEXT | `NOT NULL`, `UNIQUE` (`users_email_key`), **must be lowercase** (`CHECK (email = lower(email))`) |
| `password_hash` | TEXT | argon2id hash; **NULL** for Google-only accounts. Never selected except by login |
| `role` | TEXT | `'user'` (default) or `'admin'` (`CHECK`) |
| `email_verified_at` | TIMESTAMPTZ | NULL = never proven. Set by Google sign-in or by using a password-reset link |
| `password_changed_at` | TIMESTAMPTZ | updated by password reset |
| `created_at` | TIMESTAMPTZ | default `now()` |

#### `sessions` — one row per signed-in device
| Column | Meaning |
|---|---|
| `id` UUID | random (unguessable); travels inside access tokens as `sid` |
| `user_id` | → `users`, `ON DELETE CASCADE` |
| `user_agent`, `ip` | for the "where am I signed in" list (user agent capped at 500 chars) |
| `created_at`, `last_used_at` | `last_used_at` updated on every refresh |
| `expires_at` | **absolute** limit: 30 days after login |
| `revoked_at`, `revoke_reason` | NULL = active. Reasons: `logout`, `logout_all`, `token_reuse`, `password_reset`, `admin`, `account_linked` |

Index: `sessions_active_user_id_idx ON (user_id) WHERE revoked_at IS NULL` — a **partial index**: only active sessions are indexed, because only those are looked up.

#### `refresh_tokens` — the rotation chain
| Column | Meaning |
|---|---|
| `id` | BIGINT |
| `session_id` | → `sessions`, cascade |
| `token_hash` | **SHA-256 of the token**, `UNIQUE`. The token itself is never stored |
| `expires_at` | min(now + 7 days, session's `expires_at`) |
| `used_at` | NULL = not yet rotated. Set atomically when used |
| `replaced_by` | → the next token in the chain (R1 → R2 → R3) |

#### `password_reset_tokens`
`user_id` (cascade), `token_hash` (SHA-256, unique), `expires_at` (15 minutes), `used_at` (single use; also set when a newer link is requested), `created_at`.

#### `user_identities` — external logins linked to a user
| Column | Meaning |
|---|---|
| `user_id` | → `users`, cascade |
| `provider` | `'google'` (`CHECK`, room for more) |
| `provider_user_id` | Google's `sub` — permanent, unlike the email |
| `email`, `created_at`, `last_login_at` | for reference |
| constraints | `UNIQUE (provider, provider_user_id)`: one Google account → one user. `UNIQUE (user_id, provider)`: one user → at most one Google account |

#### `events`
`id`, `name`, `total_tickets` (`CHECK > 0`), `sale_starts_at`, `created_at`, **`price_paise`** (whole paise, ≥ 0 — never decimals for money), **`tickets_sold`** — the counter that hands out ticket numbers (`UPDATE … SET tickets_sold = tickets_sold + n RETURNING`, atomic under the row lock) with **`CHECK (tickets_sold BETWEEN 0 AND total_tickets)`**: the database itself refuses an oversell (the third safety net).

#### `orders` (used from Phase 2)
Added by 004: `hold_id` (**unique** — one order per hold), `amount_paise` (price × quantity, computed on the server), `paid_at`, `failure_reason`. Original columns:
`user_id`, `event_id`, `quantity` (`> 0`), `status` (`pending` → `paid` | `failed` | `expired`), `idempotency_key` with `UNIQUE (user_id, idempotency_key)` (a retried request can't create a second order), `payment_id`, `expires_at`, `created_at`, `updated_at`. Indexes on `user_id` and `(event_id, status)`.

#### `sold_tickets` (used from Phase 2)
`event_id`, `ticket_number` (`> 0`), `order_id`, with **`UNIQUE (event_id, ticket_number)` — the safety net of the whole project**: even if every other layer failed, the database refuses to sell ticket #7 of an event twice. Used today to rebuild Redis stock (`total − sold`).

#### `processed_webhooks` (used from Phase 2)
`webhook_id` (primary key), `provider`, `received_at` — every handled payment webhook is recorded with `INSERT … ON CONFLICT DO NOTHING` inside the payment transaction; a repeat delivery inserts nothing and is ignored (idempotency).

### Patterns used with PostgreSQL

| Pattern | Where | Why |
|---|---|---|
| **Connection pool** (max 10) | [config/db.js](../server/src/config/db.js) | Opening a connection is slow; borrowing one is fast. Extra queries wait in line (backpressure) |
| **`withTransaction(fn)`** | config/db.js | `BEGIN` / `COMMIT` / `ROLLBACK` / release on one borrowed connection. Throwing inside → rolled back |
| **Let the constraint decide** | register, Google linking | `INSERT` and catch error `23505` (unique violation) instead of "check first" — a check-then-insert is a race |
| **`UPDATE … WHERE … RETURNING`** | refresh rotation, reset links | Check-and-act in ONE statement. Postgres locks the row; concurrent requests re-check the `WHERE` and lose |
| **`SELECT … FOR UPDATE`** | admin role changes, Google linking | Lock rows until commit so a count/decision can't change underneath |
| **Lock in a fixed order** (`ORDER BY id FOR UPDATE`) | admin "last admin" rule | Two transactions locking the same rows in different orders could deadlock |
| **Slow work outside transactions** | password reset (argon2 before `BEGIN`) | A transaction holds a connection and row locks until it ends |
| **Return vs throw inside a transaction** | refresh reuse (return → keep the revocation) vs reset "password = email" (throw → undo the claim) | Decide whether the writes should survive the error |
| **Explicit column lists** | every repository | `SELECT *` could leak a sensitive column added later |
| **`$1` placeholders** | every query | Values travel separately from SQL text: no SQL injection |
| **Window function** `count(*) OVER ()` | admin user list | One query returns the page **and** the total |

---

## Redis — the fast working memory

Redis runs every command one at a time, so **one command is atomic**. Several steps that must happen together are put in a **Lua script**, which Redis also runs as one uninterruptible step.

### Every key

| Key | Type | Content | Expires | Written by |
|---|---|---|---|---|
| `event:<eventId>:stock` | string (number) | tickets available | never | event creation; holds (−); releases (+); rebuilt from Postgres if missing |
| `hold:<holdId>` | hash | `userId`, `eventId`, `quantity`, `createdAt`, `expiresAt` (ms, Redis clock) | **never on purpose** — released explicitly (see [07](07-tickets-and-holds.md)) | `create-hold.lua` / `release-hold.lua` |
| `event:<eventId>:user:<userId>:hold` | string | that user's hold id for that event | never (deleted on release) | the same scripts |
| `holds:by-expiry` | sorted set | member = hold id, score = `expiresAt` (ms): every hold by expiry time | never (entries removed with their hold) | the hold Lua scripts (ZADD on create, ZREM on release/consume, atomically); `indexAllHolds()` at worker start |
| `bull:expirations:*` | BullMQ's own keys | the job queue: delayed, waiting, active, completed, failed jobs, the sweep schedule | per job settings | BullMQ ([jobs/](../server/src/jobs/)) |
| `wr:<eventId>:queue` · `wr:<eventId>:seq` · `wr:<eventId>:pass:<userId>` · `wr:active` | sorted set · counter · string · set | the waiting room: line by arrival number, the arrival counter, admission passes, rooms with people waiting | passes: `ADMISSION_PASS_SECONDS` (600) | [waiting-room/](../server/src/modules/waiting-room/) — see [14](14-waiting-room.md) |
| `session:revoked:<sessionId>` | string `"1"` | "this session is over" | **15 min** (an access token's lifetime) | [revocation.js](../server/src/modules/auth/revocation.js) |
| `oauth:tx:<sha256(txId)>` | string (JSON) | `state`, `nonce`, `codeVerifier` of a Google sign-in in progress | **10 min**; read-and-deleted with `GETDEL` | [oauth-transactions.js](../server/src/modules/auth/oauth-transactions.js) |
| `ratelimit:<name>:<sha256(id)>` | string (number) | hits in the current window | the window (60 s – 1 h) | [rateLimiter.js](../server/src/lib/rateLimiter.js) + `fixed-window.lua` |
| `event:demo:stock` | string | the Phase 1 demo's counter | deleted at the end of the demo | `scripts/race-demo.js` |

Emails and IPs never appear in keys — they are SHA-256 hashed.

### The Lua scripts

| Script | Steps done atomically |
|---|---|
| [hold-stock.lua](../server/src/modules/reservation/lua/hold-stock.lua) (Phase 1 demo) | read stock → enough? → subtract |
| [create-hold.lua](../server/src/modules/reservation/lua/create-hold.lua) | read Redis time → stock exists? → user has an **active** hold? (refuse) / **expired** hold? (release it) → enough tickets? → subtract, write hold, link user |
| [release-hold.lua](../server/src/modules/reservation/lua/release-hold.lua) | hold exists? → owner check → give tickets back → delete hold → unlink user (only if the link still points at it) |
| [consume-hold.lua](../server/src/modules/reservation/lua/consume-hold.lua) | the hold was PAID for → delete it WITHOUT returning its tickets (they're sold) → unlink the user |
| [fixed-window.lua](../server/src/lib/lua/fixed-window.lua) | `INCR` the counter → if it's the first hit, `EXPIRE` it → return count and time left |

### When to use a Redis expiry (TTL) — and when not

| Key | TTL? | Reason |
|---|---|---|
| Revoked-session marker | ✅ 15 min | After 15 minutes every token of that session has expired anyway; nothing needs to happen when the key disappears |
| Sign-in attempt (OAuth) | ✅ 10 min | An abandoned attempt should simply vanish |
| Rate-limit counter | ✅ the window | That's what a window is |
| **Hold** | ❌ | If Redis silently deleted a hold, its tickets would never return to stock — nothing would remember how many to give back. **A TTL is right only when expiry needs no side effect.** |

### Persistence and loss

Redis runs with `--appendonly yes` (every write logged to disk), which reduces but does not remove the risk of losing recent data. The design never trusts Redis alone:

| If Redis loses its data | What happens |
|---|---|
| Event stock | rebuilt from PostgreSQL: `total − sold` (`SET … NX`, see [07](07-tickets-and-holds.md#rebuilding-stock-from-postgresql)) |
| Revoked-session markers | rebuilt from `sessions.revoked_at` (last 15 minutes) on startup and on every Redis reconnect |
| Holds | **lost** — their tickets come back on sale. Accepted: holds are temporary; paid tickets are in PostgreSQL |
| Rate-limit counters, sign-in attempts | lost; harmless |
