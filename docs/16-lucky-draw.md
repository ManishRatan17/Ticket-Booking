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

## Coming next

- **L2:** the draw itself: who's entered, a provably fair random order, rounds, closing.
- **L3:** the pages: "You're entered", "You won!", verifying the draw.
