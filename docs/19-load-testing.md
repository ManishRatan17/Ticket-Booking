# 19 · Load testing: 10,000 people, 300 tickets (Phase 6)

The question this project exists to answer: **300 tickets, 10,000 people pressing "buy" at the same moment.** Does it oversell? Does the server crash, hang, or answer "we can't process your request"? Who gets the tickets?

Tests (doc [10](10-testing.md)) prove the logic with a few hundred users. This phase throws **10,000 people** at the real system and then checks the **data itself** with SQL.

## How it's done

```
loadtest/setup.mjs ──► an event (300 tickets) + 10,000 signed-in people (tokens, a fake IP each)
loadtest/run.ps1   ──► the API (+ worker) as Linux containers ◄── k6 (Grafana's load tester), also a container
                       next to PostgreSQL and Redis, all in one Docker network; the API's CPU/memory sampled
loadtest/verify.mjs ─► SQL + Redis: oversold? duplicate ticket numbers? anyone over the limit? anything lost?
loadtest/cleanup.mjs ► removes the event and the 10,000 people
```

| Choice | Why |
|---|---|
| **k6 in Docker** (`grafana/k6:0.54.0`) | nothing to install on Windows |
| **arrival rate**: N new people per second, each a DIFFERENT person | k6 needs a few MB per virtual user; this laptop has ~4 GB for Docker. "10,000 virtual users at once" would need 10–50 GB. The server sees the same thing: 10,000 people's requests arriving within seconds |
| the API as a **Linux container** ([server/Dockerfile](../server/Dockerfile)), next to PostgreSQL and Redis | the first runs went k6 (Docker) → Docker Desktop's port forwarding → the API on Windows: thousands of new connections were **refused on the way in**, before reaching Node. A real server runs Linux; inside one Docker network we measure our app, not the laptop's Windows networking. (Also the start of Phase 7's deployment) |
| a **separate** API and worker | the development servers stay untouched |
| [loadtest.env](../loadtest/loadtest.env): rate limits **on**, `TRUST_PROXY=true` so each simulated person has their own IP; Cloudflare check **off** | per-person rules behave as with real visitors; we don't send 10,000 calls to Cloudflare |
| **SQL verification** afterwards | "k6 saw no errors" isn't proof. The data is |

The machine: a laptop, AMD Ryzen 5 4600H (6 cores), 7.4 GB RAM (~0.8 GB free during the runs), Docker limited to 3.8 GB. **k6, the API, PostgreSQL and Redis all share it**, so these numbers are a floor, not a ceiling.

## Results

### 1. Stampede: no waiting room, 10,000 people press "Hold" (the worst case)

Every request races for the same stock. No waiting room protects the server.

| Run | Rate offered | Answered | Failed | Tickets held | Median | p95 | Max | Not sent by k6 | API CPU / memory |
|---|---|---|---|---|---|---|---|---|---|
| 1 · API on Windows, before the fixes | 1,000/s | 8,232 | **7,319** (6,529 refused connections, **790 server errors**) | **300** ✅ | — | 6.0 s | 10.5 s | 1,769 | 75 % / 207 MB |
| 2 · Linux container, before the fixes | 1,000/s | 4,373 | 0 | **300** ✅ | 790 ms | 8.9 s | 13.4 s | 5,627 | 124 % / 196 MB |
| 3 · Linux container, **after the fixes** | 1,000/s | 7,761 | 0 | **300** ✅ | 145 ms | 6.8 s | 13.4 s | 2,240 | 130 % / 209 MB |
| 4 · Linux container, after the fixes | **500/s** | 9,982 | **0** | **300** ✅ | **6 ms** | **327 ms** | 2.2 s | 19 | 126 % / 196 MB |

("Not sent by k6" = k6 had no free virtual user to start them; those people never clicked. CPU 100 % = one core.)

**What it shows:**

- **Never oversold, not once**, in any run, even run 1 where the server was failing. The atomic Redis script and the PostgreSQL constraints did their job under the worst load.
- **One Node process on this laptop handles about 480 hold clicks a second**, with no waiting room. Below that (run 4: 500 a second, 10,000 people in 20 s), answers are fast: half within 6 ms, 95 % within a third of a second. Above it, requests **wait** but don't fail.

### 2. Waiting room: 10,000 people join, then buy (the real design)

10,000 people join the lobby (500 a second); the sale opens; the worker lets in 50 people a second; everyone keeps checking their status (500 checks a second, like the live page); whoever is let in buys 2 tickets: hold → order → pay (fake provider + signed webhook).

| Requests | Failed | Median | p95 | Max | Not sent | Let in & seen | Paid orders | Tickets sold | API CPU / memory |
|---|---|---|---|---|---|---|---|---|---|
| 32,979 | **0** | **3 ms** | **48 ms** | 1.3 s | **0** | 178 | **150** | **300** ✅ | 133 % / 204 MB |

**Verified with SQL:** 300 sold, numbers 1–300 with **no duplicates**, 150 paid orders, 0 pending or failed, at most 2 per person, and in Redis on sale (0) + held (0) + sold (300) = 300. (178 people were let in, 150 bought: the last 28 arrived as the tickets ran out. Admission then **paused**, step 4g, and everyone else saw "Sold out".)

**This is the answer to the question.** With the waiting room, the busy part (holding tickets) only sees a steady 50 people a second, whatever the crowd. The crowd's own traffic (joining, checking "where am I?") is cheap Redis work: 10,000 people cost a median of **3 ms** per request. Nobody is turned away with "server busy": they get a place in line.

## What the load test found, and what was fixed

| Found | Why it happened | Fix | Effect |
|---|---|---|---|
| **790 × "timeout exceeded when trying to connect"** (run 1) | every Hold click asked PostgreSQL **4** questions (restricted? the event, the person's limit, how many bought). 1,000 clicks a second = 4,000 queries a second for **10** connections; requests waited > 2 s and failed. The rule "Redis is working memory, the database only at payment" had quietly been broken by Phases 5 and the support inbox | [shortCache.js](../server/src/lib/shortCache.js): the event, restrictions and limits reused from memory for **1 s**, with **single-flight** (1,000 simultaneous misses share ONE query); pool 10 → 20 (`DB_POOL_MAX`) | server errors 790 → **0** |
| Every "sold out" answer still did all the per-person work | the checks ran before looking at the stock | **sold-out fast path**: not enough left and no hold of this person's → `SOLD_OUT` straight from Redis (one `MGET`). ~97 % of clicks in a sell-out end there | throughput 256 → **481**/s, median 790 → **145** ms |
| "Is this person restricted?" hit PostgreSQL for every NEW person (cache misses) | the cache can't help someone it has never seen | restricted accounts are **listed in a Redis set**; only listed people are checked in PostgreSQL. Rebuilt from PostgreSQL if Redis loses it, and at least hourly | (part of the above) |
| Thousands of **refused connections** | Windows + Docker Desktop's port forwarding, not our app | test inside one Docker network (Linux), as a real server would run | refused connections → **0** |

Each fix has tests: [short-cache.test.js](../server/test/short-cache.test.js) (single-flight: 1,000 misses → 1 query; expiry; delete; failures not cached), the fast path doesn't skip a person's own expired hold (mutation-tested), and the restricted list is rebuilt after Redis loses it. The general test suite runs with the cache **off** (`HOT_CACHE_MS=0`): tests change the database directly and expect to see it at once.

**The price of the 1-second cache:** after an admin approves "more tickets" or lifts a restriction, **another** API server may see it up to 1 second late (this server sees it at once). The payment transaction always reads the database, so the final check is exact.

## Honest limits

- **One laptop runs everything.** k6's 400–1,200 virtual users, PostgreSQL, Redis and the API compete for 6 cores and ~4 GB. On a real server (or with k6 on another machine) the numbers would be higher.
- **One API process.** The API keeps no state of its own (everything is in Redis and PostgreSQL), so more throughput = more API processes behind a load balancer (Phase 8). Not measured yet.
- **The live page uses Server-Sent Events**; k6 imitates it with status checks (500 a second). 10,000 open SSE connections were not tested, and are the next thing to measure (Phase 8: Redis pub/sub instead of one Redis read per connection per second).
- The "are you a person?" check was off (we don't load-test Cloudflare); everything else, including rate limits and bot strikes, was on, and **no real-looking person was struck**.

## Run it yourself

```powershell
docker compose up -d
docker build -f server/Dockerfile -t ticketing-api:loadtest .          # once, and after code changes
node --env-file=server/.env loadtest/setup.mjs stampede 10000 300       # or: waiting-room 10000 300
powershell -File loadtest/run.ps1 -Rate 500                             # -Rate = new people per second
node --env-file=server/.env loadtest/verify.mjs                         # the SQL checks
node --env-file=server/.env loadtest/cleanup.mjs                        # remove the event and the people
```

Results land in `loadtest/.data/` (git-ignored: it also holds the 10,000 login tokens).
