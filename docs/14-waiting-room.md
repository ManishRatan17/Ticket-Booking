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
| `wr:<eventId>:queue` | sorted set | member = user id, score = place in line: a **random number in [0, 1)** for people who joined in the lobby (the fair draw), the **arrival number** (≥ 1) for people who came after the sale opened |
| `wr:<eventId>:seq` | counter | hands out arrival numbers 1, 2, 3, … |
| `wr:<eventId>:pass:<userId>` | string with TTL | "admitted" — expires after `ADMISSION_PASS_SECONDS` (default 600) |
| `wr:active` | set | event ids whose room has people waiting (so the worker only checks those) |

The prefix `wr` is configurable (`WAITING_ROOM_PREFIX`); tests use `test-wr` so a development worker — which admits people every second — never touches their rooms.

**Why a sorted set:** your position is `ZRANK` — one fast command even with 100,000 people in line — and `ZADD` stores each member once. **Why arrival numbers, not timestamps:** two people joining in the same millisecond would tie; a counter (`INCR`) can't.

## The two Lua scripts (each one atomic step)

**[join-queue.lua](../server/src/modules/waiting-room/lua/join-queue.lua):** already admitted → say so (with the pass's time left). Already in the line (second tab, reload, double click) → **keep the original place**. Lobby not open yet → `not_open`. Otherwise enter the line (a random score in the lobby, the next arrival number after the sale opened; see the fair draw below) and mark the room active. Return `lobby` + the lobby's size before the sale, or your position and the line's length after. *Tested: 300 people joining at the same instant get positions exactly 1–300; joining again doesn't move you or add a second place (mutation-tested).*

**[admit.lua](../server/src/modules/waiting-room/lua/admit.lua):** `ZPOPMIN` the N earliest, give each a pass with an expiry, and — **in the same step** — if the line is now empty, take the room off `wr:active`. (Done separately, someone could join between "is it empty?" and "stop checking" and wait forever: check-then-act again.) *Tested: two admission runs at once admit 2 × N, nobody twice.*

## The admission worker

`admit-waiting` runs **every second** (a BullMQ job scheduler, set up by every worker at startup — still one schedule). For each active room whose **sale has started**, admit `admission_per_second` people. Rooms of deleted events are cleaned up. It's only logged when it actually admits someone.

**The lobby:** joining is allowed **before** the sale opens. People gather, and admission starts the moment the sale does. The estimated wait includes the time until the sale.

**The fair draw (step 4e): first come, first served, or random?** Pure first come just moves the spike: everyone (and every bot) hits Join at 10:45:00.000 instead of 11:00:00, and the fastest connection wins. Pure random would let someone who arrives at 11:20 jump ahead of someone who waited since 10:45. So it's a **hybrid**, the way large ticketing sites do it:

```
            10:45 lobby opens                 11:00 sale opens
  ──────────────┬─────────────────────────────────┬──────────────────────────────►
                │  join any time: same chance     │  join: back of the line, in order
                │  score = random in [0, 1)       │  score = arrival number 1, 2, 3 … (≥ 1)
                │  page: "You're in the lobby     │  page: "You're #340 of 1,800"
                │   with 1,800 people"            │
  line at 11:00:  [ lobby people in random order ][ later arrivals, first come first served ]
```

- **No shuffle step:** each lobby joiner gets a random score the moment they join. Random scores are already a random order, and every later arrival's score (≥ 1) is bigger than every lobby score (< 1). `ZPOPMIN` (admission) and `ZRANK` (position) work unchanged.
- **The random number** comes from Node's `crypto.randomBytes` (48 bits, a cryptographically secure source), passed into the script. Not Lua's `math.random`: Redis seeds it in ways that aren't meant for fairness.
- **Positions are hidden until the sale opens:** the status is `lobby` with the lobby's size, no position and no estimate. "Your place is drawn at 11:00" is what the page says. (The draw really happens as people join, but nobody sees it before 11:00, so it's the same thing.)
- **Re-joining never re-draws:** a second tab or a reload keeps the original score (`ZSCORE` exists → nothing changes). Otherwise people would reload until they got a good number.
- **What it costs bots:** arriving at the exact second gains nothing. A bot army with 1,000 accounts still gets 1,000 random places; that's what the bot check (Phase 5d) and the purchase cap are for.

*Tested: 200 people join the lobby one after another; when the sale opens, places are exactly 1–200 and the **rank correlation** between arrival order and place is near 0 (first come, first served would be 1; the test allows |r| < 0.3, more than 4 standard deviations); the first admission tick lets in exactly places 1–50 and everyone else moves up 50; newcomers after the sale get places 21–25 behind a 20-person lobby; re-joining keeps the same score. Mutation: the lobby given arrival numbers → r = 1.000, the test fails.*

**What are my chances? (step 4f)** Every status now also carries `ticketsLeft` (the live Redis stock), `buyersLeft` and a `chance` level, computed by [chance.js](../server/src/modules/waiting-room/chance.js):

```
buyersLeft ≈ ticketsLeft ÷ 2            (assumption: people buy about 2 tickets each)

in line:   people ahead < 0.7 × buyersLeft → good · < 1.3 × → maybe · otherwise → unlikely
in lobby:  share = buyersLeft ÷ people in the lobby (everyone has the same chance: the fair draw)
           share ≥ 0.8 → good · ≥ 0.3 → maybe · otherwise → unlikely

example: 1,000 tickets ≈ 500 buyers → #341 good · #601 maybe · #1,500 unlikely
         lobby of 1,800 → "about 1 in 4 people here will get tickets"
```

| Choice | Why |
|---|---|
| a **level**, not "73 %" | the inputs are guesses (people buy 1–4, some never buy, some holds expire). An exact-looking number would be wrong most of the time and make people angry |
| assume **2 tickets per buyer** | a simple, stated assumption. Phase 6's load tests or real sales could replace it with the event's real average |
| recomputed **every second**, pushed live | the SSE stream now also sends when `ticketsLeft` or the level changes, so the estimate corrects itself as tickets are held and sold |
| one `GET` of the stock per status | cheap. `ensureStock` rebuilds it from PostgreSQL if Redis lost it |

Known optimism: people already admitted but not yet holding tickets will take some too; the level catches up as soon as they hold. On the page: [ChanceNote](../client/src/components/ChanceNote.jsx) shows a coloured label (Good chance / Maybe / Unlikely) and one sentence, e.g. "1,000 tickets left, enough for roughly 500 buyers, and 340 people are ahead of you. (An estimate: it changes as tickets sell.)"

*Tested: [chance.test.js](../server/test/chance.test.js) checks the exact boundaries (349 ahead of 500 buyers → good, 350 → maybe, 649 → maybe, 650 → unlikely), the lobby shares, rounding (3 tickets → 2 buyers) and "no estimate when not in line"; over HTTP, statuses carry the numbers and follow the stock when someone holds tickets; a lobby of 20 with 10 tickets is "unlikely". Mutation: "good" never given → 4 tests fail.*

**Sold out (step 4g):** two different situations, told apart honestly:

| `chance` | When | What the page says | What the system does |
|---|---|---|---|
| `all_held` | the Redis stock is 0, but not every ticket is paid | "Sold out for now: every ticket is sold or held by someone checking out. Tickets that aren't paid within 5 minutes go back on sale. You keep your place." | the admission worker **pauses** this room |
| `sold_out` | PostgreSQL: `tickets_sold = total_tickets` (every ticket PAID: nothing can come back) | "Sold out. Every ticket for this event has been sold." No Join button | the live stream sends it and **ends**; the page stops polling |

**Why pause admission while everything is held?** A pass would be useless: there's nothing to hold. And when unpaid holds expire and tickets come back, they should go to the **next people in line**, not to people let in earlier who had nothing to buy and may have left. As soon as the stock is above 0, admission continues where it stopped. (Unknown stock, e.g. Redis just restarted → admit as usual.) Both answers come for **every** status, so someone who hasn't joined yet sees "Sold out" instead of a Join button.

*Tested: 2 tickets, both held → the next two in line stay waiting with `all_held`; the hold is released → both are let in; every ticket paid → `sold_out` for people in line and not in line; the live stream sends `sold_out` and closes. Mutation: the pause removed → the all-held test fails.*

**The lobby window (step 4d):** the lobby opens only **`lobby_minutes`** before the sale (migration [006](../server/migrations/006_lobby_window.sql), default **15**, 1–1440, set by the admin per event). Joining earlier → **`409 LOBBY_NOT_OPEN`** with `details.lobbyOpensAt`, and the status says `not_in_queue` with `lobbyOpensAt`, so the page can count down: "The waiting room opens in 12:30 (at 10:45)". Without a window, a bot (or a superfan) could take place #1 three days early. The check is inside [join-queue.lua](../server/src/modules/waiting-room/lua/join-queue.lua) using **Redis's clock** (`TIME`), the same clock as holds and passes, so every server gives the same answer at the same moment. Someone already in the line is never refused. *Tested: too early → 409 and nobody added; `lobbyMinutes: 60` lets people in 30 minutes ahead; the schema accepts 1–1440 and defaults to 15. Mutation: window check removed → the too-early test fails.*

*Tested: 300 people, rate 50 → after each of 6 ticks exactly the first 50, 100, … 300 are in — nobody ever overtakes anybody — and the empty room is no longer checked.*

## The gate

`POST /api/events/:id/holds` on a waiting-room event checks `wr:<event>:pass:<user>`; without it → **`403 NOT_ADMITTED`** (mutation-tested). The pass outlives the 5-minute hold (10 minutes), so an admitted person who lets a hold expire can still try again for a while.

## Endpoints (signed in)

| Endpoint | Answer |
|---|---|
| `POST /api/events/:id/queue` | join (or re-join) → status. Needs the "are you a person?" token (Phase 5d, [15](15-protection.md#5d--bot-check-cloudflare-turnstile--a-honeypot)) |
| `GET /api/events/:id/queue` | current status |

Status: `{ "status": "lobby" | "waiting" | "admitted" | "not_in_queue", "position", "total", "ticketsLeft", "buyersLeft", "chance": "good" | "maybe" | "unlikely" | "all_held" | "sold_out" | null, "passExpiresInSeconds", "admissionPerSecond", "saleStartsAt", "estimatedWaitSeconds", "serverTime" }`. Events without a waiting room → `409 NO_WAITING_ROOM`.

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
| end the stream when you're **admitted**, when the event is **sold out for good**, and after 10 min | nothing left to wait for; reconnecting re-runs authentication |
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
