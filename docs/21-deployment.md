# 21 · Deployment (Phase 7)

How to put the app online. Everything the **code** needs is done and tested; what's left needs **accounts in your name** (a host, an email service, Cloudflare). Each step below is "create an account, paste a value".

## What runs in production

```
                     https://your-app.up.railway.app
                                   │
             ┌─────────────────────┴─────────────────────┐
             │  web service: the Docker image             │   one service, one address:
             │  node src/db/migrate.js && node src/index.js│   the API (/api/…) AND the website
             └───────┬─────────────────────────┬─────────┘   (CLIENT_DIST), so cookies and CSRF
                     │                         │               work exactly as in development
             ┌───────┴──────┐          ┌───────┴──────┐
             │  PostgreSQL  │          │    Redis     │
             └───────┬──────┘          └───────┬──────┘
                     │                         │
             ┌───────┴─────────────────────────┴─────────┐
             │  worker service: the SAME image,           │   releases holds, waiting-room admission,
             │  start command: node src/worker.js         │   lucky draws, sends emails
             └────────────────────────────────────────────┘
```

[server/Dockerfile](../server/Dockerfile) builds it in two stages: stage 1 builds the React app; stage 2 holds only what runs (no build or test tools) plus the built website. On every start the web service brings the database up to date (`migrate.js` is recorded, so it's a no-op when nothing is new), then starts.

**Checked locally in production mode** (`NODE_ENV=production`, the real image): `/` and React pages (e.g. `/events/123`) → the website; `/api/…` → the API, unknown `/api` paths → JSON 404; built files cached for a year (their names change with their content); the security policy allows Cloudflare's widget and nothing else from outside; migrations ran; a clear warning when no email key is set.

## Production settings

`NODE_ENV=production` switches on what development lets you skip: `Secure` cookies only, rate limits / background jobs / bot strikes always on, and the server **refuses to start** without the secrets below.

| Variable | Value | Required |
|---|---|---|
| `NODE_ENV` | `production` | yes |
| `DATABASE_URL`, `REDIS_URL` | from the host's PostgreSQL and Redis | yes |
| `JWT_ACCESS_SECRET` | 64 random bytes: `node -e "console.log(require('crypto').randomBytes(64).toString('base64url'))"` | yes (server won't start) |
| `PAYMENT_WEBHOOK_SECRET` | another random value (≥ 32 bytes) | yes (server won't start) |
| `TURNSTILE_SITE_KEY`, `TURNSTILE_SECRET_KEY` | Cloudflare dashboard → Turnstile → Add widget (your domain) | yes (server won't start) |
| `TRUST_PROXY` | `1` (one proxy in front: the host's) | yes: otherwise every visitor has the proxy's IP and per-IP limits break |
| `CLIENT_URL` | `https://your-app.up.railway.app` | yes (links in emails, Google sign-in) |
| `RESEND_API_KEY`, `MAIL_FROM` | resend.com → API Keys | strongly recommended: without it emails are only printed in the logs (password reset won't reach anyone) |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REDIRECT_URI` | Google Cloud Console; redirect `https://your-app…/api/auth/google/callback` | optional ("Continue with Google") |
| `PORT` | set by the host | automatic |

**Train booking:** `TRAIN_PROVIDER=local` (the default: your own trains, added by admins). `external` needs a licensed partner: see [24](24-train-booking.md#where-trains-come-from-the-provider).

**Payments:** set `RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET` and `RAZORPAY_WEBHOOK_SECRET` (Razorpay **test** keys: no real money) and add the webhook `https://<your domain>/api/webhooks/razorpay` (event `payment.captured`) in Razorpay's dashboard. Without them the deployed demo uses the built-in fake provider. See [12 § Razorpay](12-orders-and-payments.md#razorpay-test-mode-phase-7).

## Email (Resend)

[lib/mailer.js](../server/src/lib/mailer.js): with `RESEND_API_KEY` set, emails go to Resend's API (one HTTPS call, no extra package); without it, they're printed in the console. Emails sent by the app:

| Email | When |
|---|---|
| Password reset link | "Forgot password" |
| **Receipt**: event, ticket numbers, amount | an order is paid |
| **"⚠ Bot detected: ann@example.com was suspended"** to every admin | an automatic bot strike ([18](18-bot-strikes.md), [20](20-admin-side.md)) |

They go through the **job queue** (`send-email` job): the worker delivers them and **retries** if the provider is down (5 attempts, growing pauses); one that fails every time stays in the dead-letter queue on the System page. A crash can no longer lose a password-reset email (a known limitation since Phase 2, now fixed). Delivered email jobs are **not kept** in Redis (`removeOnComplete: true`): they can contain one-time links. In development the worker prints them (look in the `worker` lines of `npm run dev`).

Resend's shared sender (`onboarding@resend.dev`) works without a domain but **only delivers to your own Resend account's email**: enough to try it. To email anyone, add and verify a domain in Resend, then set `MAIL_FROM=Tickets <tickets@yourdomain>`.

## Step by step on Railway (recommended)

Why Railway: it builds the Dockerfile straight from your GitHub repo, PostgreSQL and Redis are one click each, and the worker is a second service from the same repo. (Render's free tier sleeps after 15 minutes and background workers cost extra; Fly.io needs its command-line tool. A small VPS with Docker Compose also works.) Railway's Hobby plan is about US$5 a month; a trial credit lets you try it first. *Button names below may differ slightly as Railway's dashboard changes.*

1. **railway.app** → sign in with GitHub → **New Project** → **Deploy from GitHub repo** → `Ticket-Booking`.
2. In that service: **Variables** → `RAILWAY_DOCKERFILE_PATH` = `server/Dockerfile` (the Dockerfile isn't at the repo root).
3. **New** → **Database** → **PostgreSQL**, then again → **Redis**.
4. Web service → **Variables**: `DATABASE_URL` = `${{Postgres.DATABASE_URL}}`, `REDIS_URL` = `${{Redis.REDIS_URL}}`, and the table above.
5. **Settings** → **Networking** → **Generate Domain** → put it in `CLIENT_URL` (and in Cloudflare Turnstile's allowed domains, and Google's redirect URI if used).
6. **The worker:** **New** → **GitHub Repo** → the same repo again → same `RAILWAY_DOCKERFILE_PATH` and the same variables → **Settings** → **Custom Start Command**: `node src/worker.js`.
7. **Make yourself admin:** register on the site, then in the web service's shell: `node scripts/set-role.js you@example.com admin` → log out and in.
8. **Check:** `https://…/api/health` → `ok`; register (the "are you a person?" widget appears); the System page shows the worker green; buy a ticket with the fake payment; the receipt email arrives.

## What changed in the code for production

| Change | Why |
|---|---|
| The API serves the website when `CLIENT_DIST` is set ([app.js](../server/src/app.js)): `/assets` cached a year, other non-`/api` GETs → `index.html` | one service and one address; `SameSite=Strict` cookies and the CSRF check need the website and the API on the same origin |
| Content-Security-Policy = helmet's strict default + `https://challenges.cloudflare.com` for `script-src` and `frame-src` | Cloudflare's widget must load; nothing else from outside may |
| Multi-stage Dockerfile, migrations at start | small runtime image; the database is always up to date |
| Real email via Resend, through the job queue; receipts; admin alerts | password resets and receipts must reach people, and survive crashes |
| A startup warning when `RESEND_API_KEY` is missing in production | a silent "emails only in the logs" would go unnoticed |

*Tested: [website.test.js](../server/test/website.test.js) (website pages, `/api` stays JSON with a JSON 404, year-long caching of built files, the security policy); [mail.test.js](../server/test/mail.test.js) against a fake Resend (the request Resend receives; a 500 makes delivery fail so the job retries; `sendMail` queues a `send-email` job that isn't kept after delivery, and the worker's processor sends it); [admin-console.test.js](../server/test/admin-console.test.js) (a receipt after paying with amount and ticket numbers; an alert to admins naming the struck account; mutation: alert removed → fails).*

## Still to do in Phase 7

- **Razorpay with your test keys**: the code is done and tested against a fake Razorpay; try it with your keys.
- **The demo video** (2 minutes, script in the final report).
- **Styling**: yours, later.
