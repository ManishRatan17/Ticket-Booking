# 13 · Background jobs (Phase 3)

Work that must happen **later**, **by itself**, even if nobody is looking: an abandoned hold must give its tickets back after 5 minutes, and an unpaid order must expire.

Code: [server/src/jobs/](../server/src/jobs/) (`queue.js` producer, `processors.js` the jobs, `worker.js` consumer), [server/src/worker.js](../server/src/worker.js) (the worker process).

## Before Phase 3: lazy expiry only

```
Ann holds 4 tickets → closes the tab → nobody opens that event or order again
→ the tickets stay "held" forever ❌
```
Holds and orders were only expired when someone *looked* at them. During a flash sale, abandoned holds would quietly take tickets off sale.

## The design

```
 API process (PRODUCER)                       Redis                            Worker process (CONSUMER)
 ───────────────────────                      ─────                            ─────────────────────────
 hold created ──► queue.add('expire-hold',    bull:expirations:delayed         takes the job when it's due
                  { holdId },                 (a sorted set by due time)  ───► expireHold({ holdId })
                  { delay: until expiresAt,                                      hold gone?  → 'already_gone'
                    jobId: expire-hold-<id> })                                   too early?  → throw → retry later
                                                                                 else: pending order → 'expired'
                                                                                       release hold → tickets back
                                              failed 5 times? → kept in the "failed" list (dead-letter queue)
```

| Concept | Here |
|---|---|
| **Producer** | `scheduleHoldExpiry()`, called by the hold API right after a hold is created |
| **Queue** | `expirations` in Redis, key prefix `bull` (`JOBS_PREFIX`) |
| **Delayed job** | waits in Redis until `expiresAt`; the delay is measured with **Redis's clock** (the clock that set `expiresAt`) + 0.5 s |
| **Consumer / worker** | a separate process (`npm run worker`; `npm run dev` starts it too), up to 10 jobs at once |
| **Retries + exponential backoff** | up to 5 attempts, waiting 1 s, 2 s, 4 s, 8 s |
| **Dead-letter queue** | `removeOnFail: false`: a job that fails every attempt is **kept** for a human to inspect and retry |
| **Idempotency** | BullMQ delivers **at least once** (a worker that crashes mid-job gets it again). The job does nothing if the hold is already gone, and releasing returns tickets once — 3 simultaneous runs → tickets back once (tested) |
| **Dedup** | `jobId: expire-hold-<holdId>`: scheduling the same hold twice keeps one job |

## The job, step by step ([processors.js](../server/src/jobs/processors.js))

1. Read the hold. Gone (released by its owner, lazily, by an earlier run — or **consumed by a payment**) → `already_gone`, nothing to do.
2. Not yet expired by Redis's clock → **throw**, so BullMQ retries it a moment later (it never acts early).
3. Expire the hold's **pending order** in PostgreSQL (`UPDATE … WHERE hold_id = $1 AND status = 'pending'`). If the payment webhook is handling that order at this moment, the UPDATE waits for its row lock; if the payment won, the order is `paid` and nothing changes.
4. Release the hold (system release) → tickets back on sale.

Order first, hold second — and both steps are safe to repeat.

## Why the worker is its own process

- **Crash isolation:** a stuck or crashing job can't slow down or take down the API.
- **Independent scaling and restarts:** more workers for more jobs, without touching the API. With several workers, BullMQ still gives each job to exactly **one** of them.
- **Graceful shutdown:** on Ctrl+C the worker stops taking jobs, lets running ones **finish**, then closes its connections. (Being killed mid-job is survivable anyway: the job comes back and is idempotent.)

## Two Redis connections

BullMQ gets its **own** connection with `maxRetriesPerRequest: null` ("wait for Redis, never give up on a command"), because a worker blocks while waiting for jobs. The API's connection ([config/redis.js](../server/src/config/redis.js)) does the opposite on purpose — fail fast, so a request never hangs.

## Settings

| Variable | Default | Meaning |
|---|---|---|
| `HOLD_SECONDS` | 300 | hold length (tests use 1) |
| `JOBS_ENABLED` | on (`false` only in `.env.test`; never off in production) | schedule jobs at all |
| `JOBS_PREFIX` | `bull` | Redis key prefix for queues (tests use their own) |

## Proof ([jobs.test.js](../server/test/jobs.test.js))

A real worker runs inside the test process with 1-second holds: an **abandoned** hold is released with nobody looking; an unpaid order becomes `expired`; a paid hold is left alone (`already_gone`, tickets stay sold); three simultaneous runs return tickets once; an early run changes nothing. Mutation tests: removing the release or the scheduling fails 3 tests each.

Also verified live with `npm run dev` and `HOLD_SECONDS=3`: hold 3 tickets, close nothing, look at nothing — 6 seconds later all tickets are back and the worker logs `expire-hold … → {"outcome":"released"}`.

## The safety net (step 3b)

Per-hold jobs can be **missed**: holds created before Phase 3 have no job; scheduling can fail while Redis hiccups (the hold still succeeds); a queue can be wiped. So a second mechanism checks everything every **60 seconds**.

**The index — a sorted set.** `holds:by-expiry` holds every hold's id with its `expiresAt` as the **score**. The Lua scripts keep it up to date **in the same atomic step** as the hold itself (`ZADD` on create, `ZREM` on release, consume, and lazy release), so it can never disagree with the holds. "Which holds expired before now?" is then one fast query: `ZRANGEBYSCORE holds:by-expiry -inf <now>`.

**The sweep job** (`sweep-expired`, [processors.js](../server/src/jobs/processors.js)):
1. Takes expired holds from the index in batches of 500 — **batch after batch until none are left** (capped at 50 batches per run; the next run continues) — and runs the same idempotent `expireHold` on each. Holds that vanished some other way leave a stale index entry, which is removed.
2. Expires **pending orders past their deadline** in PostgreSQL (5 s grace, so per-hold jobs normally go first) and releases their holds — this covers orders whose hold was lost with Redis data.

**Scheduling it once:** `upsertJobScheduler('sweep-expired', { every: 60000 })` — a schedule stored in Redis. "Upsert" means every worker can call it at startup and there is still exactly one schedule (tested: 3 simultaneous setups → 1 schedule). At startup the worker also runs `indexAllHolds()` (`ZADD NX` for every existing hold) so holds from before the index existed are covered.

**Found while building it:** the first sweep test failed because the development Redis contained **hundreds of stale holds** left by a test file whose cleanup didn't delete hold keys. One batch of 500 didn't reach the test's hold — which showed that the sweep must loop until nothing expired is left, not stop after one batch. Both were fixed (the cleanup now lives in one shared helper, [test-support/redis-cleanup.js](../server/test-support/redis-cleanup.js)), and the first real sweep released all of those stale holds.

## The admin page (step 3c)

**Admin → Jobs** ([AdminJobsPage](../client/src/pages/AdminJobsPage.jsx), refreshes every 5 s) shows:
- **Workers online** — 0 means nothing is releasing expired holds (with a hint to start `npm run worker`);
- **jobs by state** — delayed (holds not expired yet), waiting, active, completed (last 1,000 kept), **failed**;
- **schedules** — the sweep, every 60 s, and when it runs next;
- **failed jobs** — the dead-letter queue: name, id, error, attempts, when — each with a **Retry** button.

Retry puts the job back in the queue (`job.retry()`) — safe because every job is idempotent. The intended workflow: a job fails every attempt → a human reads the error → fixes the cause → presses Retry. Tested end to end: an `expire-hold` job for a hold that wasn't expired yet fails (one attempt), is listed with "has not expired yet", the hold's time runs out, Retry → completed, tickets back. Verified live too: with `npm run dev` the page reports 1 worker online and the sweep running every 60 s.

API: `GET /api/admin/jobs`, `POST /api/admin/jobs/:id/retry` (`404 JOB_NOT_FOUND`, `409 JOB_NOT_FAILED`) — see [09](09-api-reference.md).

## Coming next

- **Phase 4 — waiting room (built):** a third job, `admit-waiting`, runs every second and lets N people per second in; it **pauses** a room while its stock is 0 (every ticket sold or held), so returned tickets go to the next people in line. See [14](14-waiting-room.md).
- **The admin page** is now called **System** (`/admin/system`), with a green / red "worker running" light and a plain explanation of each job ([20](20-admin-side.md)).
- **Housekeeping (daily):** a `housekeeping` job trims tables that only ever grow ([housekeeping.js](../server/src/jobs/housekeeping.js)): sessions expired or logged out more than 30 days ago (their refresh tokens go with them), password-reset links expired more than a day ago, webhook records older than 30 days (providers retry for hours or days, so repeats are still caught). **Records are never deleted**: orders, sold tickets, refunds, support requests, restrictions, lucky-draw entries, the audit log. Redis needs nothing: everything there expires by itself.
- **Refunds:** a `process-refund` job per refund: locks the refund, asks the provider whether it already happened, refunds, emails the person; retried if the provider is down. See [12](12-orders-and-payments.md#refunds).
- **Emails (Phase 7):** a `send-email` job per email, delivered by the worker with retries; delivered ones aren't kept (they can contain one-time links). See [21](21-deployment.md#email-resend).
- **Lucky draw (built):** a fourth job, `lottery-tick`, runs every 5 seconds and moves every due draw forward by one step (round 1, 2, 3, close). It's only logged when it picks winners or closes a draw. See [16](16-lucky-draw.md).
- Moving password-reset emails onto the job queue, so a crash can no longer lose one.
