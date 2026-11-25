# 14 · The waiting room (Phase 4)

When 50,000 people open the sale page at 8:00:00, letting all of them hit "Hold tickets" in the same second is how ticketing sites fall over. A **waiting room** puts them in a fair line and lets them in at a steady rate. This is called **admission control**: whatever arrives, the system behind the gate sees a predictable load.

Code: [modules/waiting-room/](../server/src/modules/waiting-room/), the `admit-waiting` job in [jobs/processors.js](../server/src/jobs/processors.js), migration [005](../server/migrations/005_waiting_room.sql).

## The flow

```
Sale page ── POST /api/events/:id/queue ──► join-queue.lua: one place per user, in arrival order
   ▲                                             │  wr:<event>:queue   (sorted set: user → arrival number)
   │ "You're #1,240 of 50,000, ~10 min"          │
   │                                     every 1 s, the admission worker (admit.lua):
   │                                     the N earliest → wr:<event>:pass:<user> (expires in 10 min)
   │                                             │
   └── "You're in!" ── POST /api/events/:id/holds ── pass check: no pass → 403 NOT_ADMITTED
```

Per event: **`admission_per_second`** (migration 005). Empty = no waiting room — the event works exactly as before. Set = a waiting room admitting that many people per second.

## Redis keys

| Key | Type | Meaning |
|---|---|---|
| `wr:<eventId>:queue` | sorted set | member = user id, score = **arrival number** |
| `wr:<eventId>:seq` | counter | hands out arrival numbers 1, 2, 3, … |
| `wr:<eventId>:pass:<userId>` | string with TTL | "admitted" — expires after `ADMISSION_PASS_SECONDS` (default 600) |
| `wr:active` | set | event ids whose room has people waiting (so the worker only checks those) |

The prefix `wr` is configurable (`WAITING_ROOM_PREFIX`); tests use `test-wr` so a development worker — which admits people every second — never touches their rooms.

**Why a sorted set:** your position is `ZRANK` — one fast command even with 100,000 people in line — and `ZADD` stores each member once. **Why arrival numbers, not timestamps:** two people joining in the same millisecond would tie; a counter (`INCR`) can't.

## The two Lua scripts (each one atomic step)

**[join-queue.lua](../server/src/modules/waiting-room/lua/join-queue.lua):** already admitted → say so (with the pass's time left). Already in the line (second tab, reload, double click) → **keep the original place**. Otherwise take the next arrival number, enter the line, mark the room active. Return your position and the line's length. *Tested: 300 people joining at the same instant get positions exactly 1–300; joining again doesn't move you or add a second place (mutation-tested).*

**[admit.lua](../server/src/modules/waiting-room/lua/admit.lua):** `ZPOPMIN` the N earliest, give each a pass with an expiry, and — **in the same step** — if the line is now empty, take the room off `wr:active`. (Done separately, someone could join between "is it empty?" and "stop checking" and wait forever: check-then-act again.) *Tested: two admission runs at once admit 2 × N, nobody twice.*

## The admission worker

`admit-waiting` runs **every second** (a BullMQ job scheduler, set up by every worker at startup — still one schedule). For each active room whose **sale has started**, admit `admission_per_second` people. Rooms of deleted events are cleaned up. It's only logged when it actually admits someone.

**The lobby:** joining is allowed **before** the sale opens. People gather, keep their arrival order, and admission starts the moment the sale does. The estimated wait includes the time until the sale.

*Tested: 300 people, rate 50 → after each of 6 ticks exactly the first 50, 100, … 300 are in — nobody ever overtakes anybody — and the empty room is no longer checked.*

## The gate

`POST /api/events/:id/holds` on a waiting-room event checks `wr:<event>:pass:<user>`; without it → **`403 NOT_ADMITTED`** (mutation-tested). The pass outlives the 5-minute hold (10 minutes), so an admitted person who lets a hold expire can still try again for a while.

## Endpoints (signed in)

| Endpoint | Answer |
|---|---|
| `POST /api/events/:id/queue` | join (or re-join) → status |
| `GET /api/events/:id/queue` | current status |

Status: `{ "status": "waiting" | "admitted" | "not_in_queue", "position", "total", "passExpiresInSeconds", "admissionPerSecond", "saleStartsAt", "estimatedWaitSeconds", "serverTime" }`. Events without a waiting room → `409 NO_WAITING_ROOM`.

## Live position: Server-Sent Events (step 4b)

`GET /api/events/:id/queue/stream` keeps one HTTP response open (`Content-Type: text/event-stream`) and writes a message whenever your position or status changes:

```
event: status
data: {"status":"waiting","position":12,"total":4800,…}

```

| Choice | Why |
|---|---|
| **SSE**, not WebSockets or polling | updates only go server → browser; SSE is plain HTTP (our cookie auth, CSRF rules and proxies just work); browsers reconnect by themselves; no extra library |
| check Redis once a second per stream, send **only when something visible changed** | `ZRANK` is cheap; no traffic while nothing moves |
| `: ping` comment every 15 s | stops proxies from closing a quiet connection |
| `retry: 2000` | after a drop, the browser reconnects in 2 s |
| end the stream when you're **admitted**, and after 10 min | nothing left to wait for; reconnecting re-runs authentication |
| `req.on('close')` stops the timers | a closed tab costs nothing |
| at most **3 open streams per user** (Phase 5c); the 4th → `429 TOO_MANY_STREAMS`, and that page polls instead | 5,000 "tabs" from a script can't tie up 5,000 connections ([15](15-protection.md#5c--duplicate-tabs-at-most-3-live-streams-per-user)) |
| headers `Cache-Control: no-cache, no-transform`, `X-Accel-Buffering: no` | never cache, compress or buffer a live stream |

*Tested by reading the raw stream: position 2 → (admission tick) → 1 → (tick) → `admitted` → the server ends the stream. Not signed in → 401; no waiting room → normal JSON 409.*

With several API servers, Redis **pub/sub** could push changes to every server instead of each stream checking (Phase 8).

## The queue screen (step 4c)

| File | What it does |
|---|---|
| [api/waitingRoom.js](../client/src/api/waitingRoom.js) | `joinQueue(id)` (POST), `getQueueStatus(id)` (GET), `queueStreamUrl(id)` |
| [hooks/useQueueStatus.js](../client/src/hooks/useQueueStatus.js) | your live status: GET once → if `waiting`, open an `EventSource` and apply each `status` message → if the stream errors, close it and **poll every 2 s** instead; stops when `admitted`. `join()` joins, then bumps a counter so the effect reconnects |
| [components/WaitingRoom.jsx](../client/src/components/WaitingRoom.jsx) | `not_in_queue` → **Join the queue**; `waiting` → "You're #12 of 4,800 in line", the sale countdown ("your place is saved") and "About 0:06 to go" |
| [pages/EventPage.jsx](../client/src/pages/EventPage.jsx) | for events with `admissionPerSecond`: signed out → "Log in to join the queue"; signed in and not admitted → `<WaitingRoom>`; admitted → "**It's your turn!** Choose your tickets within 9:58" above the normal hold form. Once you hold tickets the queue is no longer watched |
| [pages/AdminEventsPage.jsx](../client/src/pages/AdminEventsPage.jsx) | new field "Waiting room: people let in per second" (empty = no waiting room → sent as `null`) |
| [lib/errorMessages.js](../client/src/lib/errorMessages.js) | `NOT_ADMITTED`, `NO_WAITING_ROOM` |

**Why a polling fallback?** `EventSource` can't refresh an expired access cookie (it isn't our `fetch` client), and it can't read the status code of a failed connection. When the stream breaks, polling through `api()` refreshes the cookie on 401 and keeps the screen moving. Polling every 2 s is fine for the few people whose stream broke, but it would be too expensive for everyone, which is why the stream comes first.

**Why the page asks for status once before opening the stream:** most visitors are `not_in_queue` or already `admitted`, and they don't need a connection held open.

**Demo:** `npm run seed:demo` gives *Demo: Big Festival* a waiting room letting 2 people in per second. Join with two accounts (two browsers, or one private window) and watch the second one move from #2 to admitted.

*Checked live against a separate API + worker on port 5059: holding without queueing → `403 NOT_ADMITTED`; A joins → #1, B joins → #2; B's stream: `waiting #2` at +0.36 s → `admitted` at +1.24 s (one admission tick let both in, rate 2/s); B then holds → `201`.*

## Coming next

- **Phase 5 (protection):** bot and abuse defences around the queue and the hold endpoint.
