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

## Coming next

- **3b — safety net:** holds that never got a job (created before Phase 3, or scheduling failed while Redis hiccuped) and overdue orders are found by a periodic **sweep**, using a sorted set of holds by expiry.
- **3c — admin page:** queue counts, the failed jobs (dead-letter queue) with their errors, and a Retry button.
