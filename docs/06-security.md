# 06 · Security

Every defence in the project, the attack it stops, and where it lives. Most have a test that fails if the defence is removed (see [10](10-testing.md#mutation-testing)).

## Summary table

| Attack | Defence | Where |
|---|---|---|
| Stolen password database | argon2id (slow, memory-hard, salted) | [password.js](../server/src/modules/auth/password.js) |
| Weak / common passwords | 10–128 chars, top-1,000 common list, ≠ email | [auth.schemas.js](../server/src/modules/auth/auth.schemas.js) |
| Learning which emails have accounts (message) | identical answers: login `INVALID_CREDENTIALS`, forgot-password always 200 | auth.service.js |
| …(timing) | dummy-hash verify for unknown users; forgot-password doesn't wait for the email | auth.service.js |
| Forged / edited tokens | HS256 signature; algorithm pinned; `iss`, `aud`, `exp`, payload shape checked | [tokens.js](../server/src/modules/auth/tokens.js) |
| Weak signing secret | server refuses to start without ≥ 32 bytes | [config/env.js](../server/src/config/env.js) |
| XSS stealing tokens | both tokens in **HttpOnly** cookies; frontend never touches them | [auth.cookies.js](../server/src/modules/auth/auth.cookies.js) |
| CSRF (another site using your cookies) | `SameSite=Strict` + `Sec-Fetch-Site`/`Origin` guard on POST/PATCH/DELETE | [middleware/csrf.js](../server/src/middleware/csrf.js) |
| Stolen refresh token | rotation + reuse detection → whole session revoked | auth.service.js `refresh` |
| Logged-out token still working | Redis revoked-session check on every request | [revocation.js](../server/src/modules/auth/revocation.js), [authenticate.js](../server/src/middleware/authenticate.js) |
| Brute force, credential stuffing, spam | Redis rate limits | [rateLimiter.js](../server/src/lib/rateLimiter.js), [auth.rate-limits.js](../server/src/modules/auth/auth.rate-limits.js) |
| Mass assignment (`"role":"admin"` in a body) | zod strips unknown fields; handlers read only `req.validated` | [middleware/validate.js](../server/src/middleware/validate.js) |
| SQL injection | `$1` placeholders everywhere; ids validated (UUID / positive integer) before SQL | repositories, schemas |
| IDOR (touching someone else's object by id) | ownership in the SQL `WHERE`; answer **404**, not 403 | sessions, holds |
| Privilege escalation | default-deny admin router; role re-checked inside transactions; no API to self-promote | app.js, admin.service.js |
| Account pre-hijacking (Google) | "verified email wins" linking | [05](05-google-login.md#account-linking-four-cases-one-transaction-with-retry) |
| Login CSRF / code theft / token replay (Google) | state + cookie, PKCE, nonce, `aud` check | google.js |
| Leaked reset links | token in `#fragment`; SHA-256 stored; 15 min; single use; newest only | auth.service.js |
| Account takeover after a reset | reset revokes **all** sessions | auth.service.js |
| Huge request bodies (DoS) | 10 KB JSON limit; 128-char password max | app.js |
| Information leaks in errors | bugs → generic `500 INTERNAL_ERROR`; details only in server logs | [errorHandler.js](../server/src/middleware/errorHandler.js) |
| Clickjacking, MIME sniffing, framework fingerprinting | helmet headers; `X-Powered-By` removed | app.js |
| Secrets in git | `.env` ignored; `.env.example` has empty values; checked before every commit | `.gitignore` |
| Malicious install scripts (supply chain) | npm `allowScripts`: argon2's compile script denied | root `package.json` |
| Fake "I paid" from the browser | the browser can only START a payment; only a signed webhook marks an order paid | [payments/](../server/src/modules/payments/) |
| Forged / altered payment webhooks | HMAC-SHA256 over the exact raw body, constant-time comparison, secret required in production | [signature.js](../server/src/modules/payments/signature.js) |
| Duplicate webhooks / double charges | `processed_webhooks` + order row lock + `already_paid` check; `Idempotency-Key` on order creation | payments.service.js, orders.service.js |
| Client choosing the price | amount computed on the server from `price_paise`; a body field is ignored | orders.service.js |
| Selling more tickets than exist | atomic Lua scripts; `UNIQUE (event_id, ticket_number)` in PostgreSQL | [07](07-tickets-and-holds.md) |

## CSRF in detail

Cookies are attached by the browser **automatically** — including to requests that another website triggers. Two layers:

1. **`SameSite=Strict`** on both token cookies: modern browsers don't attach them to requests started by other sites.
2. **[csrf.js](../server/src/middleware/csrf.js)**, for every request that is not `GET`/`HEAD`/`OPTIONS`:

| Header (set by the browser; a page can't fake it) | Allowed | Blocked (`403 CSRF_REJECTED`) |
|---|---|---|
| `Sec-Fetch-Site` | `same-origin`, `none` (typed / bookmark) | `cross-site`, `same-site` (another subdomain may belong to someone else) |
| `Origin` (older browsers) | `CLIENT_URL` or our own host | anything else, including `null` |
| neither | allowed — not a browser (curl, Postman, servers); CSRF is a browser attack | |

`GET` is never blocked, which is why nothing that changes data is a `GET` (logout is `POST`; a `GET` logout could be triggered by an `<img>` tag on any site). Tested with the real attack: a valid victim cookie + `Sec-Fetch-Site: cross-site` on `logout-all` → 403, victim still signed in.

## Rate limiting in detail

**Algorithm:** fixed window, one Lua script ([fixed-window.lua](../server/src/lib/lua/fixed-window.lua)): `INCR` the counter and, on the first hit, `EXPIRE` it — atomically (two separate commands and a crash between them would leave a counter that never expires: blocked forever; mutation-tested, TTL was −1). **Count first, then decide:** 20 parallel guesses get counts 1…20, so exactly 5 reach the password check (a "check, then count" design would let all 20 through).

| Limit | Key | Window |
|---|---|---|
| login, per IP | IP | 30 / 15 min |
| login, failed attempts (reset after a success) | IP + email | 5 / 15 min |
| register | IP | 5 / hour |
| refresh | IP | 60 / minute |
| Google start | IP | 20 / minute |
| forgot password | IP · email | 5 / hour · 3 / hour |
| reset password | IP | 10 / 15 min |

- **IP + email, not email alone:** a per-email limit would let an attacker lock any victim out by failing on purpose. With the IP in the key the attacker only locks themselves out (tested).
- **Response:** `429 RATE_LIMITED`, `Retry-After` header, `RateLimit-Limit/Remaining/Reset` headers, message "Try again in N minutes".
- **Redis down → fail open** (allowed, logged): rate limiting protects the system; blocking everyone would be worse. Contrast: the revocation check **fails closed**. Seen live with Redis stopped: login 200, `/me` 503.
- **`TRUST_PROXY`:** behind a hosting proxy every request comes from the proxy's IP; the real one is in `X-Forwarded-For` — but anyone can **send** that header, so Express only believes it when told exactly which proxies to trust (`1` on Railway/Render, empty locally). Trusting too much lets an attacker pick a fresh "IP" for every request.
- **In development** everything is `127.0.0.1`, so limits are shared by every test you run by hand (register: 5 per hour). That's expected. The general test suite switches limits off via [server/.env.test](../server/.env.test); production can never switch them off.

## Fail open vs fail closed

| Check | If Redis is down | Why |
|---|---|---|
| Session revoked? | **closed** → `503 AUTH_UNAVAILABLE` | a security decision: never let a possibly-revoked token through |
| Rate limit | **open** → allowed, warning logged | a protection: refusing everyone hurts more |

## Cookies

See [04 § cookies](04-authentication.md#4-the-cookies-authcookiesjs). `COOKIE_SECURE=false` in `server/.env` only if a local tool (e.g. Postman over plain http) refuses `Secure` cookies; impossible in production.

## Settings that matter for security (`server/.env`)

| Variable | Meaning |
|---|---|
| `JWT_ACCESS_SECRET` | ≥ 32 random bytes; generate with the command in `.env.example`. Never commit |
| `GOOGLE_CLIENT_SECRET` | never commit; rotate in Google Console if exposed |
| `CLIENT_URL` | the app's origin; used by the CSRF guard and in emailed links |
| `TRUST_PROXY` | see above |
| `COOKIE_SECURE` | see above |
| `NODE_ENV=production` | forces Secure cookies and rate limits on |
| `RATE_LIMITS_ENABLED`, `RATE_LIMIT_PREFIX` | test-only switches |

## Not done yet (honest list)

- Rate limit on ticket holds (Phase 5; one-hold-per-user already limits damage).
- Email verification at registration and 2FA (future work).
- A persistent audit-log table (role changes are only logged to the console).
- A real email provider and HTTPS (deployment, Phase 7).
