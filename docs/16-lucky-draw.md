# 16 · The lucky draw

The waiting room (doc [14](14-waiting-room.md)) is fair about **order**: the lobby gets a random order, later arrivals queue behind it. But it's still a line. With 1,000 people and 200 tickets, person #800 has no chance at all, and knows it.

The **lucky draw** sets aside part of the tickets and gives them away by a **random draw** among everyone in the waiting room. Speed doesn't help, and each account gets one entry, so it's also bad news for bots.

```
11:00  Sale opens        800 tickets → the normal line (fair draw in the lobby, then first come, first served)
                         200 tickets → set aside in the lucky draw's own pool; the line can't touch them
11:00–11:30              everyone in the waiting room is entered automatically (one entry per account)
11:30  The draw          winners get a "lucky pass": 10 minutes to buy up to 2 lucky-draw tickets
11:40, 11:50             unclaimed tickets → drawn again among the rest (rounds 2 and 3)
12:00  Close             anything left goes back to the normal sale
```

Settings per event (admin form, migration [007](../server/migrations/007_lucky_draw.sql)):

| Setting | Default | Allowed | Why the limits |
|---|---|---|---|
| `lotteryPercent` | 0 (no draw) | 0–50 | at 100 % the line would be pointless: a different product |
| `lotteryDrawMinutes` (after the sale opens) | 30 | 1–1440 | a fixed, announced time can't be gamed, and gives people time to join |
| `lotteryPerWinner` | 2 | 1–4 | fewer per winner = more lucky people |
| — | — | needs a waiting room | the entrants ARE the people in the waiting room |

`lottery_tickets = floor(total × percent ÷ 100)`, fixed when the event is created (20 % of 1,000 = 200; 20 % of 3 = 0, so no draw).

## Step L1 · Two pools of tickets

The lucky draw only works if its tickets are really **set aside**: if the line could buy them, there'd be nothing left to draw at 11:30.

| Redis key | Holds |
|---|---|
| `event:<id>:stock` | the normal sale's tickets |
| `event:<id>:lottery-stock` | the lucky draw's tickets |
| `event:<id>:lottery-closed` | exists once the draw is over (its leftovers now belong to the normal sale) |
| `wr:<id>:lucky:<userId>` | a winner's **lucky pass** (set by the draw, step L2) |

Every hold now records its **pool** (`main` or `lottery`) in its Redis hash:

| Where | What changed | Why |
|---|---|---|
| [create-hold.lua](../server/src/modules/reservation/lua/create-hold.lua) | takes from the stock key it's given (normal or lucky), stores `pool` | one script, two pools |
| …its lazy expiry | an expired old hold's tickets go back to **their own** pool, which may differ from the new hold's | a winner's expired lucky hold must not leak into the normal sale |
| [release-hold.lua](../server/src/modules/reservation/lua/release-hold.lua) | `pool = 'lottery'` → back to `lottery-stock`, unless the draw is closed → back to the normal stock | release, expiry job and sweep all use this script, so all three are right |
| `holdTickets` ([events.service.js](../server/src/modules/events/events.service.js)) | a user with a lucky pass holds from the lucky pool, up to `lotteryPerWinner` (else `409 LUCKY_DRAW_LIMIT`), **without** needing a waiting-room pass | winning the draw is the pass |
| orders (`orders.pool`) | the order keeps the hold's pool; a **late** payment takes from the same pool | needed to rebuild each pool |
| `ensureStock` | rebuilds **both** pools from PostgreSQL: lucky = `lottery_tickets − sold from the draw`; normal = `total − all sold − what the draw still has` | Redis is the fast copy, PostgreSQL the truth (as since Phase 1) |

The purchase cap (4 per person, Phase 5b) counts tickets from both pools.

*Tested in [lucky-draw-pool.test.js](../server/test/lucky-draw-pool.test.js): 20 % of 1,000 → pools of 800 and 200; the schema's limits (≤ 50 %, 1–4 per winner, needs a waiting room); the normal sale sells its 5, the 6th → `SOLD_OUT` while the draw's 5 are untouched; a winner holds from the lucky pool without a waiting-room pass, 3 → `LUCKY_DRAW_LIMIT`; released lucky tickets return to the lucky pool; an expired lucky hold replaced by a normal hold returns to the lucky pool; orders keep their pool, and when Redis loses both pools each is rebuilt correctly. Mutation: release always returning to the normal stock → the release test fails.*

## Step L2 · The draw

Code: [modules/lottery/](../server/src/modules/lottery/), migration [008](../server/migrations/008_lucky_draw_results.sql), the `lottery-tick` job (every 5 s).

### Who is entered

Everyone who **joins the waiting room** of an event with a draw: [join-queue.lua](../server/src/modules/waiting-room/lua/join-queue.lua) adds them to the set `wr:<event>:entrants`. One entry per account (it's a set), and they stay entered after being let in by the line. At round 1 the set is **frozen** into `lottery_entries`: joining later doesn't count.

### Provably fair: commit–reveal

```
event created ──► seed = 32 random bytes (secret)          seedHash = SHA-256(seed)  → shown to everyone
                                                                       (the COMMIT)
draw time    ──► entrants frozen; seed REVEALED
                 each entrant's draw number = HMAC-SHA256(key = seed, "<eventId>:<userId>")
                 lowest numbers win first
anyone       ──► SHA-256(revealed seed) = the fingerprint shown before?   → the seed wasn't changed
                 HMAC(seed, "<eventId>:<my id>") = my number?              → my place is honest
```

- **Why commit first:** if the seed were chosen at draw time, the admin could try seeds until a friend wins. Publishing its SHA-256 in advance fixes it: a different seed has a different fingerprint, and SHA-256 can't be reversed.
- **Why HMAC per person, not "shuffle the list":** your number depends only on the seed and your own id, not on who else entered or in what order. Easy to explain, easy to check, and nobody can change anyone else's number by joining.
- **Honest limits:** you can verify **your own** number and the fingerprint; checking the whole list would need everyone's ids, which we don't publish (privacy). And whoever can read the database could see the seed early; the commit stops them **changing** it, not knowing it.

[lottery.js](../server/src/modules/lottery/lottery.js) is three lines: `makeSeed`, `hashSeed`, `drawNumber`. The seed and its fingerprint are created **in the same transaction as the event** (an event with a draw but no seed can't exist).

### Rounds

| Step | When | What happens |
|---|---|---|
| Round 1 | the draw time (sale + `lotteryDrawMinutes`) | freeze the entrants, reveal the seed; winners = the lowest numbers, as many as `ceil(lucky tickets left ÷ per winner)`; each gets a **lucky pass** (`wr:<event>:lucky:<user>`, 10 minutes) |
| Rounds 2, 3 | a full round (10 min) after the previous one | tickets not taken, or released, go to the **next** numbers in line |
| Close | a full round after round 3 | [close-lottery.lua](../server/src/modules/lottery/lua/close-lottery.lua) moves what's left to the normal stock and sets `lottery-closed`, atomically; `events.lottery_closed_at` is set |

| Rule | How |
|---|---|
| **Nobody wins twice** | `PRIMARY KEY (event_id, user_id)` on `lottery_winners`, and the next-winners query skips existing winners |
| Skip people at the **4-ticket limit** | the next-winners query skips anyone with 4 paid tickets: the next number wins instead |
| **Two workers at once** | the draw row is locked (`SELECT … FOR UPDATE`): the second waits, then sees the round already done |
| A worker that was **down** for a while | each step waits a full round after the PREVIOUS step (`last_round_at`), so winners always get their full 10 minutes |
| A **crash** between giving passes (Redis) and committing (PostgreSQL) | the round isn't recorded, so the next tick runs it again, and picks the **same** people (numbers are fixed). Nobody is wrongly let in |
| Lucky tickets released **after** closing | `release-hold.lua` sees `lottery-closed` and returns them to the normal sale |

`LOTTERY_ROUND_SECONDS` (default 600) sets the round length.

*Tested in [lucky-draw.test.js](../server/test/lucky-draw.test.js): before the draw the fingerprint is public and the seed secret, joining = entered, nothing happens before the draw time; round 1 with 12 entrants and 10 tickets → exactly the 5 lowest numbers, and the revealed seed matches the fingerprint and the page's own number; winners hold lucky tickets for 10 minutes, others can't; two jobs at once → one round; round 2 waits a full round, then the next 3 numbers win, nobody twice; someone at the 4-ticket limit is skipped; after 3 rounds the draw closes, 8 leftovers go to the normal sale, and a lucky hold released after closing goes there too; a draw nobody entered returns everything; **fairness: over 2,000 seeds each of 10 entrants has the lowest number about equally often** (chi-square < 27.9, the 0.1 % level). Mutations: winners chosen by user id instead of draw number → 3 tests fail; no wait between rounds → 2 tests fail.*

## Coming next

- **L3:** the pages: "You're entered", "You won!", verifying the draw.
