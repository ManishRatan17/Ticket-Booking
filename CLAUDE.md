# Flash-Sale Ticketing System — session handoff

Read this first. It is loaded automatically at the start of every Claude Code session, so a new
session can continue without re-reading the whole project. **Update "Where we are" at the end of
every step, in the same commit.** Details live in `docs/` — read only the doc you need.

## Where we are (updated 2026-11-26)

- Last step: payments for bus + train (step 4). Next: the bus/train booking PAGES on the website (not built yet),
  then deploy (needs the user's accounts).
- Tests: **417 server + 50 client**, all passing, 0 skipped. Migrations up to **018** (dev DB migrated).
- **Backend features are complete.** Done, in order: auth (+Google), holds (Redis Lua), orders +
  payments (fake + Razorpay test mode), background jobs (BullMQ), waiting room, protection (rate
  limits, cap, Turnstile, honeypot), lucky draw, support inbox, bot strikes, admin side, load test
  (10,000 users → exactly 300 sold), email (Resend), refunds, daily housekeeping, admin audit log,
  cancelling an event.
- **Backend phase (2026-11-27), agreed plan:** (1) train-error fixes DONE (proxy 502 API_UNREACHABLE, worker in
  /api/health, lib/httpClient.js); (2) bus module DONE (modules/bus, docs/23); (3) train module DONE (modules/train, docs/24: TRAIN_PROVIDER local | external → 503/501); (4) payments for bus + train DONE
  (modules/booking-payments, docs/12 "Paying for bus and train bookings"). Backend plan complete.
  A booking with a fare is confirmed by PAYING (fake provider / Razorpay); free trips by the passenger details. Seats: DB-enforced one active booking per seat per trip.
- **Deploy (later):** — Railway recommended (Dockerfile ready, guide in
  `docs/21-deployment.md`). Needs the user's own accounts: Railway, Cloudflare Turnstile, Resend;
  then set the Razorpay webhook URL to the public site. Secrets go into Railway's settings, never into chat or git.
- Later / optional: Phase 8 scale-out, metrics, email verification, names on accounts.
- **Frontend (2026-11-27):** landing page with 4 categories, each opening with its own full-screen animation
  (components/transitions/, lib/transitionRun.js, route /book/:category). Train + Bus bookable (events → booking);
  Movie + Flight = full-screen ComingSoon (`available: false` in lib/categories.js). TrainLoader was removed.
  Committed. Browser checks: a CDP script driving headless Chrome (in the session scratchpad).
  The user designs the rest of the UI; only build the UI they ask for.
- **Design system (2026-11-28):** ALL colours/spacing/radii/shadows/motion are tokens in client/src/styles/tokens.css
  (no raw colour anywhere else: keep it that way). Animations + Coming soon share SceneBackdrop (one scene, one livery).
  New pages: reuse .button/.card/.panel/.badge/.alert/.field and the tokens. See docs/08 "Design system".
- `project.txt` (repo root) is the user's own notes file: never commit or edit it.

## How the user wants to work (always)

1. When asked to do something: first reply with **a plan, the options with trade-offs, and a
   recommendation — then STOP** until the user says "continue" (or gives advice).
2. Small steps. After each: explain **what / how / why** in plain language (it's a learning project).
3. Mark every file **NEW / CHANGED / DELETED** in the summary.
4. Update `docs/` in the same change (status, API `09`, data `03`, tests `10` + mutation results,
   decisions `11`, the topic doc, test counts in `docs/README.md` and root `README.md`).
5. Tests for every feature, and **mutation-test** important protections (break it → a test must fail → restore).
6. Git: commit + push each finished step **by file name** (never `git add .`, never `.env`), message
   ending with the Co-Authored-By line, then explain the git commands used.
7. Never print secret values (Razorpay keys are in `server/.env`, git-ignored).

## Run it (PowerShell, from the repo root)

```powershell
docker compose up -d          # PostgreSQL 16 + Redis 7 (start Docker Desktop first)
npm run migrate               # apply new migrations to the dev database (the server does NOT migrate on start)
npm run dev                   # API :5000 (PORT in server/.env) + worker + website :5173 (proxies /api → 5000)
npm test                      # server (node:test, real DB) then client (Vitest)
npm run lint ; npm run build  # client lint + production build
npm run set-role -- you@example.com admin   # make an admin (then log out and in)
```

The user usually runs the app in a window titled "TicketBooking - npm run dev". Don't kill their processes.

## Gotchas that cost time before

- **Shell:** Windows. Bash heredocs with backticks/quotes break → write scripts to the scratchpad
  and run `node script.cjs`. Background node processes from Git Bash linger → use PowerShell
  `Start-Process` / `Stop-Process`.
- **Docker Desktop stops by itself sometimes:** start
  `C:\Users\Asus\AppData\Local\Programs\DockerDesktop\Docker Desktop.exe`.
- **No Prettier config** in this repo: never run Prettier (it rewrites whole files). Style: server
  = single quotes + semicolons; client = single quotes, no semicolons; long lines are fine.
- `git checkout -- file` writes CRLF; edit scripts matching LF text must normalise `\r\n` first.
- **Tests use their own DB** `ticketing_test` + Redis db 1 (`server/.env.test`; `pretest` creates
  and migrates it). Real Razorpay/Resend are switched off there. Jobs are off in tests (refunds run inline).
- A test must wait for its own in-flight work before failing (`Promise.allSettled`), or its cleanup
  races it and leaves data that makes the "last admin" tests skip.
- Test files that create admins take `holdWhileCreatingAdmins()` (test-support/admin-lock.js).
- Razorpay test mode: card `4111…` is refused (international). Use UPI `success@razorpay` or the
  Indian card `4100 2800 0000 1007` (any future date, any CVV, OTP 4–10 digits).
- The API runs under `node --watch`: ANY server-file edit restarts it (a few seconds of 502 API_UNREACHABLE).
  `/api/health` → `services.worker` shows whether the background worker is running.
- NEVER put backticks inside a bash `node -e "…"` string: bash runs them as commands. Use a script file.
- Lock order in payments: **order row, then event row**. Anything new that locks both must do the same (deadlock otherwise — measured).

## Map of the code

- `server/src/modules/` — auth, events (+ `events.cancel.js`), reservation (Redis Lua holds/stock),
  orders, payments (fake, razorpay, refunds), waiting-room, lottery, support, moderation, admin.
- `server/src/jobs/` — BullMQ queue, processors, housekeeping. `server/src/lib/` — audit, mailer, rate limits, shortCache.
- `server/migrations/001–018` · `server/test/` (one file per feature) · `server/test-support/` (fakes, helpers).
- `client/src/` — pages, api, components, hooks, lib (error texts, statuses). React 19 + Vite.
- `loadtest/` — k6 in Docker. `.github/workflows/test.yml` — CI. `server/Dockerfile` — deploy image.

## Map of the docs (`docs/`)

01 architecture · 02 tech stack · 03 data (tables, migrations, Redis keys) · 04 auth · 05 Google login ·
06 security · 07 tickets & holds · 08 frontend · 09 API reference · 10 testing (+ mutations, lessons) ·
11 decisions log · 12 orders, payments, refunds, cancelling · 13 background jobs · 14 waiting room ·
15 protection · 16 lucky draw · 17 support inbox · 18 bot strikes · 19 load testing · 20 admin side ·
21 deployment · 22 demo script · 23 bus booking · 24 train booking.
