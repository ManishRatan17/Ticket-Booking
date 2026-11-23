# 07 · Tickets and holds — the concurrency core

The reason the project exists: **never sell a ticket twice**, even when thousands of people click "buy" in the same second.

## 1. The bug we set out to avoid (Phase 1, Step 1)

[stock.js](../server/src/modules/reservation/stock.js) still contains, on purpose, the obvious version:

```js
const stock = await getStock(eventId);              // 1. CHECK (read)
if (stock < quantity) return false;                  // 2. decide
await redis.set(stockKey(eventId), stock - quantity); // 3. ACT (write)
```

Correct for one user — wrong for many. Every `await` lets other requests run. 1,000 buyers all read "100" before anyone writes, all decide "enough!", and all write "99":

```
npm run demo:race
=== Naive check-then-act (broken) ===   buyers told "yes": 1000   stock left: 99   ❌ OVERSOLD by 900
=== Fix #1: DECRBY + undo ===            buyers told "yes": 100    stock left: 0    ✅
=== Fix #2: Lua script ===               buyers told "yes": 100    stock left: 0    ✅ (fastest)
```

Vocabulary: **race condition** (result depends on timing), **check-then-act** (read → decide → write, with a gap), **lost update** (writes overwrite each other), **atomicity** (the cure: check and act as one step).

## 2. The fixes (Phase 1, Step 2)

| Fix | How | Problem |
|---|---|---|
| `DECRBY` + undo | subtract and get the new value in one command; if negative, `INCRBY` back | while briefly negative, other buyers are wrongly refused; a crash between the two commands loses tickets |
| **Lua script** ([hold-stock.lua](../server/src/modules/reservation/lua/hold-stock.lua)) | Redis runs the whole script as one uninterruptible step | none of the above; one network round trip. Rule: keep scripts short — Redis does nothing else while one runs |

**Pessimistic vs optimistic vs atomic:** locking a PostgreSQL row (`FOR UPDATE`) would make every buyer queue on one row; "try, detect, undo" is optimistic; a Lua script needs no lock because nothing can interrupt it. For one hot counter, the Redis atomic operation wins.

## 3. Holds (Phase 1, Step 4a) — [holds.js](../server/src/modules/reservation/holds.js)

A counter doesn't know **who** has the tickets. A hold does:

```
event:7:stock               → 96
hold:3f2a…                  → { userId: 42, eventId: 7, quantity: 4, createdAt, expiresAt }   (Redis hash)
event:7:user:42:hold        → 3f2a…
```

Rules: **5 minutes** (`HOLD_SECONDS`), **1–4 tickets** (`MAX_TICKETS_PER_HOLD`), **one active hold per user per event**.

### create-hold.lua — in this order, nothing can run in between

1. `now` = **Redis's clock** (`TIME`).
2. Stock key missing? → `-1` (a bug: stock never loaded — thrown, not "sold out").
3. User already has a hold here? **Active** → `-2` + its id (refused). **Expired** → release it right here ("lazy expiry"), tickets back to stock.
4. Not enough tickets? → `0` + how many are left; **nothing changes**.
5. Subtract, write the hold hash, link the user → `1` + `expiresAt`.

**Returned vs thrown:** "sold out" and "already holding" are normal business outcomes → returned values. Invalid input or missing stock means our code is wrong → thrown errors. The HTTP layer turns the first into `409`, the second into `500`.

### release-hold.lua — idempotent

Hold gone? → `0`. Asked by someone who isn't the owner (system calls pass no user) → `-1`. Otherwise: tickets back (if the stock key exists), delete the hold, unlink the user only if the link still points at this hold → `1`. Releasing twice returns tickets **once** — essential because the user's button, payment (Phase 2) and the expiry worker (Phase 3) may all release the same hold, possibly at the same instant.

### One clock

Every expiry decision compares **Redis time with Redis time**. The browser and Node's clocks are only used for display (and the tests allow a couple of seconds of slack between Redis's clock in Docker and Windows' clock — they really did differ by ~1 ms and broke a too-strict test).

### Why holds have no Redis TTL

If Redis deleted an expired hold by itself, its tickets would **never** come back to stock: nothing would remember how many to return. Expired holds are released **explicitly**:
- by the **same user** creating a new hold (lazy expiry, inside create-hold.lua);
- when the owner **looks** at their hold (`GET …/holds/mine` releases an expired one);
- by the **background worker** (Phase 3): every hold gets a delayed `expire-hold` job when it is created — see [13](13-background-jobs.md).

## 4. Events and the HTTP API (Phase 1, Step 4b) — [modules/events/](../server/src/modules/events/)

| Endpoint | Who | Notes |
|---|---|---|
| `POST /api/admin/events` `{ name, totalTickets, saleStartsAt }` | admin | saved in PostgreSQL, then stock loaded into Redis |
| `GET /api/events`, `GET /api/events/:id` | anyone | `available` (live from Redis), `onSale`, `serverTime` |
| `POST /api/events/:id/holds` `{ quantity }` | signed in | `201` · `409 SOLD_OUT` · `409 HOLD_EXISTS` · `409 SALE_NOT_STARTED` · `400` · `404` |
| `GET /api/events/:id/holds/mine` | signed in | your hold or `null` |
| `DELETE /api/holds/:holdId` | owner | `204`; someone else's → `404` (IDOR) |

**The server decides when a sale opens** (`saleStartsAt` vs Redis time). Hiding a button in the browser protects nothing.

### Rebuilding stock from PostgreSQL

`ensureStock(event)` in [events.service.js](../server/src/modules/events/events.service.js): if `event:<id>:stock` is missing (Redis restarted empty, flushed, new instance), compute `total − count(sold_tickets)` and write it with **`SET … NX`** ("only if still missing").

Why `NX`: if 30 requests notice the missing key at the same moment while holds are being taken, a plain `SET` from a late request would **overwrite** stock that holds already reduced — creating tickets out of nothing. With `NX` exactly one rebuild wins (tested: 20 reads + 10 holds racing a rebuild → stock 30 of 40; without `NX` the test fails every time).

Creating an event writes PostgreSQL first, Redis second; if Redis fails, `ensureStock` simply loads it on first use.

### `serverTime`

Every events/holds response includes `serverTime` (Redis's clock). The frontend computes "time left = `expiresAt` − server now", so a user whose computer clock is minutes off still sees the right countdown ([08](08-frontend.md#countdowns-that-dont-trust-the-users-clock)).

## 5. Proof

| Test | Result |
|---|---|
| 1,000 buyers × 100 tickets on the counter, 5 rounds | exactly 100 each round |
| 1,000 users × 100 tickets as **holds** | exactly 100 holds, 100 different users, stock 0 |
| 300 users wanting 1–4 tickets | tickets conserved (held + left = 100); nobody refused while enough were left |
| one user clicking 50 times at once | exactly 1 hold |
| 20 parallel releases of one hold | tickets returned once |
| **300 signed-in users over real HTTP** (cookies, CSRF guard, authenticate, validation, Lua) | **exactly 100 × 201, 200 × `SOLD_OUT`, stock 0** |
| sanity check: the naive version under the same load | oversells (proves the tests can see a race) |

Every one of these was also run against a deliberately broken version (mutation testing) and failed — see [10](10-testing.md#mutation-testing).

## What is not automatic yet

- **Holds are lost** if Redis loses its data (their tickets come back on sale).
- **Redis Cluster:** the scripts build some key names from data (e.g. `'hold:' .. id`) instead of declaring every key; fine on one Redis, would need hash tags on a cluster (Phase 8).
- **Turning a hold into a paid order** (`orders`, `sold_tickets`, idempotency, webhooks) is Phase 2.
- **No rate limit on holds** yet (Phase 5).
