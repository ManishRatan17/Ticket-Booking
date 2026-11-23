# 09 · API reference

Base URL in development: `http://localhost:5173/api` (through Vite) or `http://localhost:5000/api` (direct).

## Conventions

- JSON in and out (`Content-Type: application/json`), bodies ≤ 10 KB.
- **Authentication:** the `access_token` cookie (sent automatically by the browser). No `Authorization` header is used.
- **CSRF:** `POST`/`PATCH`/`DELETE` from another website are refused (`403 CSRF_REJECTED`).
- **Errors** always look like:
  ```json
  { "error": { "code": "VALIDATION_ERROR", "message": "Request validation failed",
               "details": [ { "field": "body.password", "message": "Use at least 10 characters" } ] } }
  ```
  `code` is stable for programs; `message` is for people; `details` is optional (a list of field errors for 400, or an object such as `{ "available": 2 }`).
- **401 responses** carry `WWW-Authenticate: Cookie realm="flash-sale-api"`.
- **429 responses** carry `Retry-After` (seconds) and `RateLimit-Limit` / `RateLimit-Remaining` / `RateLimit-Reset`.

### Errors any endpoint can return

| Status | Code | When |
|---|---|---|
| 400 | `INVALID_JSON` | body isn't valid JSON |
| 400 | `VALIDATION_ERROR` | body / query / URL parameter fails its schema (`details` lists every field) |
| 403 | `CSRF_REJECTED` | state-changing request started by another site |
| 404 | `NOT_FOUND` | no such route |
| 413 | `PAYLOAD_TOO_LARGE` | body over 10 KB |
| 500 | `INTERNAL_ERROR` | a bug (details only in the server log) |

### Errors of protected endpoints (`authenticate`)

| Status | Code | Meaning | Frontend reaction |
|---|---|---|---|
| 401 | `AUTH_REQUIRED` | no access cookie | refresh once, retry |
| 401 | `TOKEN_EXPIRED` | access token expired | refresh once, retry |
| 401 | `INVALID_TOKEN` | bad signature / format / account deleted | signed out |
| 401 | `SESSION_REVOKED` | session ended (logout elsewhere, reset, demotion, theft) | signed out |
| 503 | `AUTH_UNAVAILABLE` | Redis unreachable (fail closed) | error message |

---

## Health

### `GET /api/health`
`200 { "status": "ok", "uptime": 12.3, "services": { "postgres": { "status": "up" }, "redis": { "status": "up" } } }`
or `503` with `"status": "degraded"` and the failing service's `error`.

---

## Auth — `/api/auth`

### `POST /register`  · limit 5/hour per IP
Body `{ "email": "ann@example.com", "password": "at least ten characters" }` (unknown fields are dropped)
→ `201 { "user": { "id", "email", "role", "createdAt" } }` · `400` · `409 EMAIL_TAKEN` · `429`

### `POST /login`  · limits 30/15 min per IP, 5 failures/15 min per IP+email
Body `{ email, password }`
→ `200 { "user": {…}, "expiresIn": 900 }` + `Set-Cookie: access_token`, `refresh_token` · `400` · `401 INVALID_CREDENTIALS` · `429`

### `POST /refresh`  · limit 60/min per IP · uses the `refresh_token` cookie
→ `200 { "expiresIn": 900 }` + two new cookies
· `401 REFRESH_TOKEN_MISSING` / `INVALID_REFRESH_TOKEN` / `REFRESH_TOKEN_EXPIRED` / `SESSION_REVOKED` / `SESSION_EXPIRED` / `REFRESH_TOKEN_REUSED` (cookies cleared)
· `409 REFRESH_CONFLICT` (used by another tab ≤ 10 s ago; cookies untouched — just retry) · `429`

### `POST /logout`  · uses the `refresh_token` cookie
→ `204` always; both cookies cleared.

### `GET /me`  · signed in
→ `200 { "user": { "id", "email", "role", "createdAt" } }`

### `POST /logout-all`  · signed in
→ `204`; every session of the user revoked; cookies cleared.

### `GET /sessions`  · signed in
→ `200 { "sessions": [ { "id", "userAgent", "ip", "createdAt", "lastUsedAt", "expiresAt", "current": true } ] }` (active only, most recent first)

### `DELETE /sessions/:id`  · signed in
`id` must be a UUID (`400` otherwise) → `204` · `404 SESSION_NOT_FOUND` (not yours, unknown or already ended)

### `POST /forgot-password`  · limits 5/hour per IP, 3/hour per email
Body `{ email }` → **always** `200 { "message": "If an account exists for this email, we have sent a link to reset the password." }` · `400` · `429`

### `POST /reset-password`  · limit 10/15 min per IP
Body `{ "token": "<43 characters from the link>", "password": "new password" }`
→ `204` (all sessions revoked, cookies cleared) · `400 VALIDATION_ERROR` (weak password, or equal to the email — the link stays usable) · `400 RESET_TOKEN_INVALID` (unknown, used, superseded or expired)

### `GET /google`  · limit 20/min per IP · a browser navigation
→ `302` to Google (+ `oauth_tx` cookie) · `503 GOOGLE_NOT_CONFIGURED` · `429`

### `GET /google/callback?code=…&state=…` (or `?error=…`)
Always `302` to `CLIENT_URL`:
`/?login=google` (+ both token cookies) · `/?login=cancelled` · `/?login=failed&reason=<CODE>` with `OAUTH_TX_INVALID`, `OAUTH_STATE_MISMATCH`, `OAUTH_CODE_MISSING`, `GOOGLE_EXCHANGE_FAILED`, `GOOGLE_TOKEN_INVALID`, `GOOGLE_EMAIL_UNVERIFIED`, `GOOGLE_ACCOUNT_CONFLICT`, `GOOGLE_UNAVAILABLE`, `GOOGLE_NOT_CONFIGURED`, `INTERNAL_ERROR`

---

## Admin — `/api/admin` (signed in **and** role `admin`, else `401` / `403 FORBIDDEN`)

### `GET /users?limit=20&offset=0`
`limit` 1–100 (default 20), `offset` ≥ 0 → `200 { "users": [ { "id", "email", "role", "createdAt", "hasPassword", "hasGoogle" } ], "total", "limit", "offset" }`

### `PATCH /users/:id/role`
Body `{ "role": "user" | "admin" }` → `200 { "user": {…} }`
· `404 USER_NOT_FOUND` · `409 LAST_ADMIN` · `403 FORBIDDEN` (you were demoted meanwhile)
Demotion revokes all of that user's sessions immediately; promotion applies at their next refresh.

### `POST /events`
Body `{ "name": "3–120 chars", "totalTickets": 1–100000, "saleStartsAt": "2026-12-01T18:00:00Z", "pricePaise": 49900 }` (any date, also past; `pricePaise` whole paise 0–10,000,000, default 0)
→ `201 { "event": { "id", "name", "totalTickets", "saleStartsAt", "pricePaise", "createdAt", "available", "onSale" } }`

---

## Events & holds — `/api`

### `GET /events`
→ `200 { "events": [ { "id", "name", "totalTickets", "saleStartsAt", "createdAt", "available", "onSale" } ], "serverTime" }`

### `GET /events/:id`
→ `200 { "event": {…}, "serverTime" }` · `400` (not a positive integer) · `404 EVENT_NOT_FOUND`

### `POST /events/:id/holds`  · signed in
Body `{ "quantity": 1 }` (JSON integer 1–4)
→ `201 { "hold": { "id", "eventId", "quantity", "expiresAt" }, "serverTime" }`
· `409 SOLD_OUT` (`details.available`) · `409 HOLD_EXISTS` (`details.holdId`) · `409 SALE_NOT_STARTED` (`details.saleStartsAt`) · `404 EVENT_NOT_FOUND` · `400`

### `GET /events/:id/holds/mine`  · signed in
→ `200 { "hold": {…} | null, "serverTime" }` (an expired hold is released and reported as `null`)

### `DELETE /holds/:holdId`  · signed in
`holdId` must be a UUID → `204` · `404 HOLD_NOT_FOUND` (not yours, unknown, or already released)

---

## Orders — `/api` (signed in)

### `POST /orders`
Header **`Idempotency-Key: <8–128 letters, digits, - or _>`** (the browser makes one random key per checkout attempt and re-sends it on retries). Body `{ "holdId": "<uuid>" }`. The amount comes from the database (`price_paise × quantity`); the order's deadline is the hold's deadline.
→ `201 { "order": {…}, "serverTime" }` the first time · `200` + header `Idempotent-Replayed: true` for a retry with the same key (same order)
· `400 IDEMPOTENCY_KEY_REQUIRED` · `404 HOLD_NOT_FOUND` (unknown or not yours) · `409 HOLD_EXPIRED` · `409 ORDER_EXISTS` (`details.orderId`: this hold already has an order) · `422 IDEMPOTENCY_KEY_REUSED` (same key, different hold)

Order shape: `{ "id", "eventId", "eventName", "quantity", "amountPaise", "status": "pending|paid|failed|expired", "expiresAt", "paidAt", "failureReason", "ticketNumbers": [], "createdAt" }`

### `GET /orders/:id`
→ `200 { "order": {…}, "serverTime" }` · `404 ORDER_NOT_FOUND` (unknown or not yours). A pending order past its deadline is marked `expired` here and its held tickets return to sale.

### `GET /orders`
→ `200 { "orders": [ … ] }`, newest first.

---

## Trying it with curl

```bash
# log in, keep cookies in a jar, then use them
curl -c jar.txt -H "Content-Type: application/json" \
     -d '{"email":"ann@example.com","password":"correct horse battery staple"}' \
     http://localhost:5000/api/auth/login
curl -b jar.txt http://localhost:5000/api/auth/me
curl -b jar.txt -H "Content-Type: application/json" -d '{"quantity":2}' http://localhost:5000/api/events/1/holds
```
