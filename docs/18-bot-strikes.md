# 18 · Bot strikes: suspensions and bans (Phase 5e)

Phase 5 made abuse **expensive** (rate limits, purchase cap, stream cap, "are you a person?"). This step makes it **costly to the account**: an account that behaves like a bot gets a strike. The first strike pauses ticket booking for 15 days, and a second strike within a year bans the account.

The guiding rule: **only proof, never a guess.** Banning a real fan because they clicked fast, or because their college shares one IP, would be worse than a bot getting through.

```
signal ──► points (Redis, fade after 10 minutes) ──► 20 points ──► STRIKE
                                                                     │
          1st strike in a year → SUSPENDED: booking paused 15 days   │ the person can still sign in,
          2nd strike in a year → BANNED for good                     │ see why, and APPEAL
                                                                     ▼
          cleanup: unpaid orders and holds released, queue places and passes removed
```

## Signals

| Signal | Points | Why it's evidence | Where |
|---|---|---|---|
| `rate_limited`: an **action** refused by a **per-user** limit (hold, release, join a queue, order, pay) | 1 | the limits are set so a person clicking as fast as they can never reaches them ([15 § 5a](15-protection.md#5a--rate-limits-on-the-ticket-path)) | the `onRefused` hook of those limiters ([ticketRateLimits.js](../server/src/lib/ticketRateLimits.js)) |
| `missing_bot_token`: joining a queue with **no** "are you a person?" token | 5 | our page never sends a join without one (the button waits for it) | [botCheck.js](../server/src/middleware/botCheck.js) |
| `bad_bot_token`: a token Cloudflare rejects | 2 | forged or replayed; but an EXPIRED token can happen to a person, so it counts less | the same |

**20 points within 10 minutes → a strike.** A script hammering holds gets there in seconds (live: 35 requests → 10 allowed, 20 refused, strike, the rest refused as restricted). A person never produces a signal at all (tested).

**What never counts** (all tested or by design):

- **IP-based refusals**: a whole college or office shares one IP; those limits have no `onRefused`.
- **Status polling**: someone with many tabs open isn't a bot.
- **The register honeypot**: there's no account yet to strike, so it's just refused.

### How a signal is counted

[add-signal.lua](../server/src/modules/moderation/lua/add-signal.lua), one atomic step: add the points to `bot:score:<user>` (expires 10 minutes after the first signal), count the kind in `bot:signals:<user>` (**the evidence**), and if the score reaches 20, `SET bot:flagged:<user> NX` so it triggers **once**. "Count, then decide", like the rate limiter. Recording a signal never throws: a protection must not break the request that triggered it.

## Strikes and restrictions

Migration [010](../server/migrations/010_moderation.sql): `account_restrictions` (user, `kind` suspended/banned, reason, `evidence` JSON, `starts_at`, `ends_at` NULL = permanent, `created_by` NULL = automatic, `lifted_at`, `overturned`).

| Rule | How |
|---|---|
| 1st strike → suspended `BOT_SUSPENSION_DAYS` (default 15, max 30) | counts this person's restrictions in the last 365 days, not overturned |
| 2nd strike within a year → **banned** | same count ≥ 1 |
| Strikes older than a year, and **overturned** ones (mistakes), don't count | tested |
| A suspension **ends by itself** | "in force" = not lifted and (`ends_at` is NULL or in the future). No job reopens accounts: the date passing is enough |
| Two strikes at the same moment → one restriction | the user row is locked (`FOR UPDATE`), and an account already restricted isn't struck again |
| The evidence is kept with the restriction | the signal counts, score, threshold and window: what an admin reviews |

**Cleanup after a strike:** unpaid orders → `expired`, every hold released (tickets back on sale), the person removed from every waiting room, waiting-room and lucky-draw passes deleted. A bot account shouldn't keep tickets tied up while it's suspended.

## Enforcement: booking paused, account not locked

[requireNotRestricted](../server/src/middleware/requireNotRestricted.js) sits right after `authenticate` on **booking** actions: hold, join a queue, create an order, pay. It runs **before** the per-user limits, so a restricted account is turned away without collecting more signals. Answer: `403 ACCOUNT_RESTRICTED` with `{ kind, until, reason }`. It's checked in PostgreSQL (one indexed query), so it's always right.

Everything else still works: signing in, reading events, My orders, releasing tickets, and **the support inbox**, so the person can appeal. `/me` and the login response include `restriction`, so every page shows a banner:

> **Unusual, automated activity was detected on your account.** Ticket booking is paused until 10 Dec 2026, 18:30. You can still sign in and see your orders. If you think this is a mistake, **appeal**.

The wording says "unusual activity", not "you are a bot": detection is never 100 % sure.

## Appeals and admins

- **Appeal**: a new kind of support request ([17](17-support-inbox.md)), only while restricted (`409 NOT_RESTRICTED` otherwise). An admin **upholding** it overturns the restriction **in the same transaction**: booking works at once, and it won't count as a strike.
- **Admin page** (`/admin/restrictions`, [AdminRestrictionsPage](../client/src/pages/AdminRestrictionsPage.jsx)): restrictions in force (or all) with their evidence ("20 × actions refused by rate limits, score 20 in 10 min"); **Lift early** (still counts as a strike) or **Overturn** (a mistake: doesn't count); **restrict by hand** by email (suspend N days, or ban). Admins can't restrict themselves.
- Every strike, lift and overturn is logged (`[moderation] user 41 suspended until … (automatic): {evidence}`).

**A banned person can't simply sign up again with the same email** (emails are unique), and "Continue with Google" with that email lands on the same banned account. New emails need a new "are you a person?" check each time (Phase 5d). Stronger identity checks (phone or email verification) are future work.

## Settings

| Setting | Default | Where |
|---|---|---|
| `BOT_SUSPENSION_DAYS` | 15 (1–30) | `server/.env` |
| threshold / window | 20 points / 10 minutes | `env.moderation` in [config/env.js](../server/src/config/env.js) |
| `MODERATION_ENABLED` | on (always on in production) | off only in `.env.test` for the general suite |

*Tested in [bot-strikes.test.js](../server/test/bot-strikes.test.js) (rate limits, the bot check and moderation switched on with private prefixes and a fake Cloudflare): normal clicking → no signal; **13 people on one IP, IP limit refusing some → nobody gets a signal**; a script: 10 allowed, 20 refusals → suspended 15 days, automatic, evidence `{ rate_limited: 20 }`; after a strike the hold is released, the queue place gone, and hold/join/order/pay → 403; restricted people still see `/me`, events and the support inbox, and login returns the restriction; 4 joins without a token → strike; a fake token = 2 points; a second strike within a year → banned; old or overturned strikes don't count; the suspension ends by itself; two strikes at once → one; appeal only while restricted, upheld → booking works and it doesn't count; admins list, restrict by email, lift, can't restrict themselves; normal users → 403. Mutations: no restriction check on holds → 3 tests fail; no "already restricted" guard → the two-strikes test fails. **Checked live** on a separate API with the development settings (above).*
