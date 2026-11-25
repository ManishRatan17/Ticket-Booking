# 04 · Authentication

Who you are, how you prove it, and how that proof is kept safe. Google sign-in has its own page: [05](05-google-login.md). All defences in one list: [06](06-security.md).

## Overview

```
REGISTER  email + password ──► password checked (rules + 1,000 most common) ──► argon2id hash stored
LOGIN     email + password ──► verify hash ──► new SESSION row ──► two cookies:
                                                 access_token   (JWT, 15 min,   Path=/api)
                                                 refresh_token  (random, ≤7 days, Path=/api/auth)
EVERY CALL   browser sends access_token ──► signature + expiry checked ──► Redis: session revoked? ──► req.user
EVERY 15 MIN browser POSTs /refresh with refresh_token ──► old one marked USED ──► two NEW cookies
LOGOUT       session revoked in PostgreSQL + Redis ──► both cookies cleared
```

All of it lives in [server/src/modules/auth/](../server/src/modules/auth/). Settings are in [config/env.js](../server/src/config/env.js).

## Lifetimes

| Thing | Lifetime | Setting |
|---|---|---|
| Access token (JWT) and its cookie | 15 minutes | `env.jwt.accessTtlSeconds` |
| Refresh token | 7 days, **sliding** (each refresh issues a fresh one), never beyond the session | `env.session.refreshTtlSeconds` |
| Session | 30 days **absolute** (password needed again after that) | `env.session.ttlSeconds` |
| "Two tabs" grace window | 10 seconds | `env.session.reuseGraceSeconds` |
| Password-reset link | 15 minutes, single use | `auth.service.js` |
| Google sign-in attempt | 10 minutes, single use | `oauth-transactions.js` |

---

## 1. Registration — `POST /api/auth/register`

```
registerPerIp (5/hour) → rejectHoneypot → validate(registerSchema) → requireHuman (Cloudflare Turnstile) → controller → service.register → repository.createUser
```

The honeypot and the "are you a person?" check (Phase 5d) are explained in [15-protection.md](15-protection.md#5d--bot-check-cloudflare-turnstile--a-honeypot).

**Validation** ([auth.schemas.js](../server/src/modules/auth/auth.schemas.js)):
- email: trimmed, lowercased, ≤ 254 characters, valid format.
- password: **10–128 characters**; **not** one of the 1,000 most common leaked passwords of that length ([data/common-passwords.txt](../server/src/modules/auth/data/common-passwords.txt), from the MIT-licensed SecLists project, checked case-insensitively); **not** equal to the email. No forced symbols/uppercase (current NIST guidance: forced complexity produces predictable passwords). The maximum stops someone sending a megabyte "password" to overload hashing.
- unknown fields (e.g. `"role": "admin"`) are **removed** → mass assignment is impossible.

**Hashing** ([password.js](../server/src/modules/auth/password.js)): argon2id, **19 MiB memory, 2 iterations, 1 thread** (OWASP minimum), ~40–100 ms per hash on this laptop. The password is Unicode-normalised (NFKC) first, so "é" typed on two different keyboards gives the same hash. The stored string `$argon2id$v=19$m=19456,t=2,p=1$<salt>$<hash>` contains its own settings and a random 16-byte **salt** — two users with the same password get different hashes, which defeats precomputed "rainbow tables".

**Duplicate emails:** no "does it exist?" check first (two parallel requests could both pass it). The service just `INSERT`s; the `UNIQUE` constraint decides atomically; error `23505` becomes **409 `EMAIL_TAKEN`**. Tested with 20 parallel registrations → exactly one succeeds.

Registration does **not** sign you in; the frontend calls login right after.

## 2. Login — `POST /api/auth/login`

```
loginPerIp (30/15 min) → validate(loginSchema) → loginAttempts (5 failures/15 min per IP+email) → controller → service.login
```

1. Find the user by email (the **only** query that reads `password_hash`).
2. **Always** run a full argon2 verify — against the user's hash, or, if there is no such user (or it's a Google-only account), against a **dummy hash** of a random password. So "no such account" and "wrong password" take the **same time** (measured: 47 ms vs 49 ms; without the dummy: 4 ms vs 42 ms — a leak an attacker could time).
3. Both failures return the **identical** `401 INVALID_CREDENTIALS`.
4. If the stored hash was made with older/weaker settings, re-hash it now (login is the only moment the plain password is available).
5. Start a session (below) and set the two cookies. JSON response: `{ user, expiresIn: 900 }` — **no token in the body**.

## 3. Sessions and the two tokens

**Starting a session** (`startSession` in [auth.service.js](../server/src/modules/auth/auth.service.js)) — one transaction:
- `sessions` row: random UUID, user agent, IP, `expires_at = now + 30 days`;
- first refresh token: 32 random bytes; only its **SHA-256** is stored in `refresh_tokens`.

**The access token** ([tokens.js](../server/src/modules/auth/tokens.js)) is a **JWT** signed with **HS256** and the secret `JWT_ACCESS_SECRET` (the server refuses to start if it is missing or shorter than 32 bytes):

```
header  {"alg":"HS256","typ":"JWT"}
payload {"sub":"7", "role":"user", "sid":"<session uuid>", "iss":"flash-sale-api", "aud":"flash-sale-web", "iat":…, "exp":… (+900 s)}
signature = HMAC-SHA256(header.payload, secret)
```
- Anyone can **read** a JWT (it's only base64url-encoded) — so it holds ids and a role, never secrets.
- Nobody can **change** it without the secret: editing `"role":"user"` to `"admin"` breaks the signature (tested).
- Verification pins the algorithm to HS256 (stops the `alg: none` attack), and checks issuer, audience and expiry; the payload shape is checked too (`sid` must be a UUID).

**Why two tokens:** a JWT is checked with maths only (fast, no database), but can't be "taken back" — so it lives only 15 minutes. The long-lived refresh token is **in the database**, so it can be revoked. Speed from one, control from the other.

**SHA-256 for refresh tokens, argon2 for passwords:** passwords are human-chosen and guessable → slow hash. Refresh tokens are 256 random bits → nothing to guess, and we must look them up by hash (`WHERE token_hash = $1`), which a salted hash can't do.

## 4. The cookies ([auth.cookies.js](../server/src/modules/auth/auth.cookies.js))

| Cookie | Path | Lifetime | Flags |
|---|---|---|---|
| `access_token` | `/api` | `Max-Age=900` | `HttpOnly; Secure; SameSite=Strict` |
| `refresh_token` | `/api/auth` | `Expires=` refresh expiry | `HttpOnly; Secure; SameSite=Strict` |
| `oauth_tx` (Google, temporary) | `/api/auth/google` | `Max-Age=600` | `HttpOnly; Secure; SameSite=Lax` |

- **HttpOnly** — JavaScript can't read them: injected script (XSS) can't steal a token.
- **Secure** — HTTPS only. Browsers treat `http://localhost` as secure, so development works. `COOKIE_SECURE=false` is an escape hatch for tools that refuse; it is ignored in production.
- **SameSite=Strict** — not sent on requests started by other websites (first CSRF defence; the second is [middleware/csrf.js](../server/src/middleware/csrf.js)).
- **Path** — the refresh token only travels to auth endpoints.

**Cookie-only authentication:** `authenticate` reads only the `access_token` cookie; an `Authorization: Bearer` header is ignored (one way in, one CSRF story). The frontend never sees or stores a token.

## 5. Checking every request — `authenticate` ([middleware/authenticate.js](../server/src/middleware/authenticate.js))

1. No cookie → `401 AUTH_REQUIRED` (the frontend then tries one refresh).
2. Verify the JWT → expired: `401 TOKEN_EXPIRED`; anything else wrong: `401 INVALID_TOKEN`.
3. **One Redis lookup:** `EXISTS session:revoked:<sid>` → `401 SESSION_REVOKED`. If Redis can't answer → **`503 AUTH_UNAVAILABLE` (fail closed)**.
4. `req.user = { id, role, sessionId }`.

`GET /api/auth/me` then loads the user **from the database** (the token is a snapshot from login; the database is the truth — a deleted account gets 401).

## 6. Refresh rotation and reuse detection — `POST /api/auth/refresh`

```
hash the cookie, then ONE transaction:
UPDATE refresh_tokens SET used_at = now()
 WHERE token_hash = $1 AND used_at IS NULL AND expires_at > now()   ← atomic "claim"
RETURNING … (+ session and user, joined)

claimed + session alive   → new refresh token (linked: old.replaced_by = new), new access token, both cookies
not found                 → 401 INVALID_REFRESH_TOKEN
unused but expired        → 401 REFRESH_TOKEN_EXPIRED
session revoked/expired   → 401 SESSION_REVOKED / SESSION_EXPIRED
already USED ≤ 10 s ago   → 409 REFRESH_CONFLICT   (another tab; NOT revoked; cookie NOT cleared)
already USED > 10 s ago   → REUSE: revoke the whole session ('token_reuse') → 401 REFRESH_TOKEN_REUSED
```

- **Rotation:** every refresh token works **once**. That makes theft detectable: thief and owner can't both keep using one token.
- **Reuse detection:** we can't tell who is the thief, so the whole session dies; the real user logs in again with the password, the thief has nothing. Other sessions of the same user are unaffected.
- **The atomic claim:** if 10 tabs refresh at once, Postgres's row lock lets exactly one see `used_at IS NULL` (tested: 1 × 200, 9 × 409). Without `AND used_at IS NULL` all 10 succeeded (mutation test).
- **The grace window:** two tabs refreshing together is normal, not theft. The loser gets 409 and simply retries — cookies are shared between tabs, so it now has the new token. A 409 must **not** clear the cookie, or it would delete the new token the other tab just stored.
- **Transactions that must not roll back:** the revocation after reuse must be **kept** even though the request fails, so the transaction **returns** an outcome, commits, and only then throws.

## 7. Logout, sessions list, revocation ([revocation.js](../server/src/modules/auth/revocation.js))

| Endpoint | Auth | Effect |
|---|---|---|
| `POST /api/auth/logout` | refresh cookie (works with an expired access token) | revoke this session ('logout'), clear both cookies → `204`. Always 204 (idempotent) |
| `POST /api/auth/logout-all` | access cookie | revoke every session of the user ('logout_all') |
| `GET /api/auth/sessions` | access cookie | active sessions, newest first, `current: true` for this one |
| `DELETE /api/auth/sessions/:id` | access cookie | revoke one of **your** sessions; someone else's → `404` (IDOR) |

**The "JWTs can't be revoked" problem, solved:** revoking writes `sessions.revoked_at` (PostgreSQL, the truth) **and** `SET session:revoked:<sid> 1 EX 900` (Redis, the fast check). Every request checks Redis, so a revoked session's access token stops working **immediately**, not after 15 minutes. The key expires after 15 minutes because by then every token of that session has expired anyway.

**One door for revoking:** reuse detection, logout, logout-all, deleting a session, Google linking, admin demotion and password reset all go through `revocation.js`, which writes Redis **before** the transaction commits — so if anything fails, the result errs on the safe side (logged out early, never a revoked session that still works).

**Redis restart:** `keepRevocationsInSync()` (called from `index.js`) copies sessions revoked in the last 15 minutes from PostgreSQL back into Redis at startup **and every time Redis reconnects**.

## 8. Roles and authorization ([middleware/authorize.js](../server/src/middleware/authorize.js), [modules/admin/](../server/src/modules/admin/))

- Roles: `user`, `admin` (column `users.role`, claim `role` in the JWT).
- `requireRole('admin')` → `403 FORBIDDEN` for a signed-in user without the role (401 = "who are you?", 403 = "we know you; no").
- **Default deny:** `app.use('/api/admin', authenticate, requireRole('admin'), adminRouter)` — the guard is applied once to the whole router; nothing inside it has auth code, so no admin route can forget it.
- **The first admin** is made from the command line: `npm run set-role -- <email> admin`. No public API can do it; register strips `role`.
- **Demotion is instant** (all the user's sessions revoked); **promotion applies at the next refresh** (refresh reads the role from the database).
- **The last admin can't be demoted** (`409 LAST_ADMIN`). The service locks all admin rows (`FOR UPDATE`, in id order) and **re-checks the acting admin's own role inside the transaction** (they may have been demoted a moment ago — time-of-check vs time-of-use).
- Role changes are logged: `[audit] admin 3 changed user 7 (…): admin → user`.

## 9. Password reset

```
POST /api/auth/forgot-password { email }       forgotPerIp 5/h, forgotPerEmail 3/h
  → ALWAYS 200 "If an account exists, we have sent a link…"   — same words, same speed, every time
  → in the background (the response does NOT wait):
       user exists? → cancel their older unused links → new 32-byte token, SHA-256 stored, 15 min
                    → email:  {CLIENT_URL}/reset-password#token=<43 characters>

POST /api/auth/reset-password { token, password }   resetPerIp 10/15 min
  → argon2-hash the new password (BEFORE the transaction: slow work never holds a connection)
  → transaction: claim the token atomically (single use)
                 password = email? → THROW (rolls back the claim, so the link still works)
                 set password_hash, password_changed_at, email_verified_at (clicking the link proves the inbox)
                 cancel other links · REVOKE ALL SESSIONS ('password_reset')
  → 204, both cookies cleared → the user logs in with the new password
```

- **Token in the `#fragment`, not `?query`:** browsers never send the fragment to any server, so it can't end up in logs or `Referer` headers. The reset page reads it, then removes it from the address bar.
- **Not waiting for the email** keeps "account exists" and "no account" equally fast (tested with a mail provider that takes 1.5 s: the response still takes < 500 ms). Trade-off: if the server crashed at that moment the email would be lost — Phase 3's job queue will fix that.
- **Mailer** ([lib/mailer.js](../server/src/lib/mailer.js)): a swappable "transport". Development prints the email in the server terminal; tests capture it in memory; a real provider plugs in at deployment.
- A Google-only account can use this to **add** a password.
