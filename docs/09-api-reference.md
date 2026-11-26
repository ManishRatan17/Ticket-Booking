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

### `GET /api/config`
Public settings for the page: `200 { "botCheck": { "siteKey": "…" | null } }` (`null` = the "are you a person?" check is off). Never contains secrets.

---

## Auth — `/api/auth`

### `POST /register`  · limit 5/hour per IP · bot check
Body `{ "email": "ann@example.com", "password": "at least ten characters" }` (unknown fields are dropped; a non-empty `website` = the honeypot → `403`)
Header `X-Turnstile-Token: <token from the widget>` when the bot check is on (see `GET /api/config`)
→ `201 { "user": { "id", "email", "role", "createdAt" } }` · `400` · `403 BOT_CHECK_FAILED` · `409 EMAIL_TAKEN` · `429`

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
Body `{ "name": "3–120 chars", "totalTickets": 1–100000, "saleStartsAt": "2026-12-01T18:00:00Z", "pricePaise": 49900, "admissionPerSecond": 50 }` (`admissionPerSecond` 1–10,000, or null = no waiting room; `lobbyMinutes` 1–1440, default 15 = the waiting room opens that many minutes before the sale; lucky draw: `lotteryPercent` 0–50 (default 0 = none; needs a waiting room), `lotteryDrawMinutes` 1–1440 after the sale (default 30), `lotteryPerWinner` 1–4 (default 2)) (any date, also past; `pricePaise` whole paise 0–10,000,000, default 0)
→ `201 { "event": { "id", "name", "totalTickets", "saleStartsAt", "pricePaise", "createdAt", "available", "onSale" } }`

### `GET /jobs`
→ `200 { "counts": { "waiting", "delayed", "active", "completed", "failed" }, "workersOnline", "schedules": [ { "name", "everyMs", "nextRunAt" } ], "failedJobs": [ { "id", "name", "data", "error", "attempts", "maxAttempts", "createdAt", "failedAt" } ] }` (the 50 most recent failures)

### `POST /jobs/:id/retry`
→ `202 { "retried": true }` · `404 JOB_NOT_FOUND` · `409 JOB_NOT_FAILED`

---

## Events & holds — `/api`

### `GET /events`
→ `200 { "events": [ { "id", "name", "totalTickets", "saleStartsAt", "createdAt", "available", "onSale" } ], "serverTime" }`

### `GET /events/:id`
→ `200 { "event": {…}, "serverTime" }` · `400` (not a positive integer) · `404 EVENT_NOT_FOUND`

### `POST /events/:id/holds`  · signed in · limits 10/min per user, 120/min per IP
Body `{ "quantity": 1 }` (JSON integer 1–4)
→ `201 { "hold": { "id", "eventId", "quantity", "pool", "expiresAt" }, "serverTime" }` (`pool`: `main`, or `lottery` for a lucky-draw winner)
· `409 SOLD_OUT` (`details.available`) · `409 HOLD_EXISTS` (`details.holdId`) · `409 LUCKY_DRAW_LIMIT` (a lucky-draw winner asked for more than `details.limit`) · `409 PURCHASE_LIMIT` (`details: { bought, limit }`: at most 4 tickets per person per event over all orders, more if an admin approved a request) · `409 SALE_NOT_STARTED` (`details.saleStartsAt`) · `404 EVENT_NOT_FOUND` · `400`

### `GET /events/:id/holds/mine`  · signed in
→ `200 { "hold": {…} | null, "purchase": { "bought", "limit" }, "serverTime" }` (an expired hold is released and reported as `null`; `purchase` = tickets you have bought for this event, and the per-person limit)

### `DELETE /holds/:holdId`  · signed in · limit 20/min per user
`holdId` must be a UUID → `204` · `404 HOLD_NOT_FOUND` (not yours, unknown, or already released)

### `POST /events/:id/queue`  · signed in · limits 10/min per user, 60/min per IP · bot check (header `X-Turnstile-Token`, else `403 BOT_CHECK_FAILED`) — join the waiting room (or re-join: you keep your place)
### `GET /events/:id/queue`  · signed in · limit 60/min per user — your status
→ `200 { "status": "lobby" | "waiting" | "admitted" | "not_in_queue", "position", "total", "ticketsLeft", "buyersLeft", "chance": "good" | "maybe" | "unlikely" | "all_held" | "sold_out" | null, "lottery": null | { "state": "upcoming" | "drawing" | "closed", "tickets", "ticketsLeft", "perWinner", "drawAt", "rounds", "roundsDone", "entrants", "entered", "odds", "winners", "won": { "round", "passExpiresInSeconds" } | null, "seedHash", "seed" (after the draw), "myDrawNumber" (after the draw) }, "passExpiresInSeconds", "admissionPerSecond", "lobbyOpensAt", "saleStartsAt", "estimatedWaitSeconds", "serverTime" }` · `404 EVENT_NOT_FOUND` · `409 NO_WAITING_ROOM` · `409 LOBBY_NOT_OPEN` (joining before the lobby window; `details.lobbyOpensAt`). `lobby` = joined before the sale: `total` is the lobby's size, no `position` yet (everyone in the lobby gets a random place when the sale opens)

### `GET /events/:id/queue/stream`  · signed in · limit 20 opens/min per user · at most 3 open at once per user (the 4th → `429 TOO_MANY_STREAMS`, plain JSON) — **Server-Sent Events**
`Content-Type: text/event-stream`; messages `event: status` with the same JSON as above, sent when the status or position changes; `: ping` every 15 s; ends when you are admitted or after 10 minutes (the browser reconnects).

On a waiting-room event, `POST /events/:id/holds` without a pass → `403 NOT_ADMITTED`.

---

## Orders — `/api` (signed in)

### `POST /orders`  · limit 10/min per user
Header **`Idempotency-Key: <8–128 letters, digits, - or _>`** (the browser makes one random key per checkout attempt and re-sends it on retries). Body `{ "holdId": "<uuid>" }`. The amount comes from the database (`price_paise × quantity`); the order's deadline is the hold's deadline.
→ `201 { "order": {…}, "serverTime" }` the first time · `200` + header `Idempotent-Replayed: true` for a retry with the same key (same order)
· `400 IDEMPOTENCY_KEY_REQUIRED` · `404 HOLD_NOT_FOUND` (unknown or not yours) · `409 HOLD_EXPIRED` · `409 ORDER_EXISTS` (`details.orderId`: this hold already has an order) · `422 IDEMPOTENCY_KEY_REUSED` (same key, different hold)

Order shape: `{ "id", "eventId", "eventName", "quantity", "amountPaise", "status": "pending|paid|failed|expired", "expiresAt", "paidAt", "failureReason", "ticketNumbers": [], "createdAt" }`

### `GET /orders/:id`
→ `200 { "order": {…}, "serverTime" }` · `404 ORDER_NOT_FOUND` (unknown or not yours). A pending order past its deadline is marked `expired` here and its held tickets return to sale.

### `GET /orders`
→ `200 { "orders": [ … ] }`, newest first.

---

## Payments

### `POST /api/payments/fake/:orderId`  · signed in · limit 10/min per user · development payment provider
Body `{ "outcome": "success" | "failure" }` → `202 { "paymentId" }` (the result arrives later by webhook; poll `GET /api/orders/:id`)
· `404 ORDER_NOT_FOUND` · `409 ORDER_NOT_PENDING` (`details.status`)

### `POST /api/webhooks/payments`  · called by the payment provider, not the browser
Header `X-Payment-Signature: sha256=<HMAC-SHA256 of the exact body>`. Body `{ "id": "evt_…", "type": "payment.succeeded" | "payment.failed", "data": { "orderId", "paymentId", "amountPaise" } }`
→ `200 { "received": true, "outcome": "paid" | "failed" | "refund_needed" | "duplicate" | "already_paid" | "ignored" | "unknown_order", "ticketNumbers"? }`
· `401 INVALID_SIGNATURE` · `400 INVALID_WEBHOOK` · `500` on a crash (the provider retries)

---

## Support inbox

People, signed in ([17](17-support-inbox.md)):

### `POST /support/requests`  · limit 5/hour per user
Body `{ "kind": "more_tickets", "eventId", "extraTickets": 1–4, "message" }` or `{ "kind": "question", "eventId"?: …, "message" }` (message 1–2,000 characters)
→ `201 { "request": { "id", "kind", "eventId", "eventName", "extraTickets", "status": "open", "messages": [{ "id", "fromAdmin", "body", "createdAt" }], … } }` · `400` · `404 EVENT_NOT_FOUND` · `409 REQUEST_EXISTS` (`details.requestId`: you already have an open one about this)

### `GET /support/requests` → `200 { "requests": [ … ] }` (newest activity first)
### `GET /support/requests/:id` → `200 { "request": { …, "messages": [ … ] } }` · `404 REQUEST_NOT_FOUND` (also for someone else's)
### `POST /support/requests/:id/messages`  · limit 30/hour per user
Body `{ "body" }` → `201 { "request" }` · `404` · `409 REQUEST_CLOSED`

Admins (`/api/admin`, role admin):

### `GET /admin/support?status=open|approved|declined|closed` → `200 { "requests": [ { …, "userEmail", "awaitingReply" } ] }` (open first, oldest first)
### `GET /admin/support/:id` → `200 { "request" }`
### `POST /admin/support/:id/messages` Body `{ "body" }` → `201 { "request" }`
### `POST /admin/support/:id/decision`
Body `{ "decision": "approved" | "declined" | "closed", "message"?: "…" }` → `200 { "request" }` · `409 REQUEST_NOT_OPEN` (already decided) · `409 NOT_APPROVABLE` (only more_tickets can be approved). Approving a `more_tickets` request raises that person's purchase limit for that event to 4 + extraTickets, in the same transaction.

## Razorpay (test mode)

When the server has Razorpay keys (`GET /api/config` → `payments: { provider: "razorpay", keyId }`; otherwise `{ provider: "fake" }`). See [12](12-orders-and-payments.md#razorpay-test-mode-phase-7).

### `POST /payments/razorpay/:orderId`  · signed in · not admins · limit 10/min
→ `200 { "keyId", "razorpayOrderId", "amountPaise", "currency": "INR", "description" }` (the same Razorpay order on every call) · `404 ORDER_NOT_FOUND` · `409 ORDER_NOT_PENDING` · `503 PAYMENTS_UNAVAILABLE`
### `POST /payments/razorpay/:orderId/verify`
Body: Razorpay's answer `{ "razorpay_order_id", "razorpay_payment_id", "razorpay_signature" }` → `200 { "outcome": "paid" | "duplicate" | "already_paid" | … }` · `400 PAYMENT_SIGNATURE_INVALID`
### `POST /api/webhooks/razorpay`  · called by Razorpay
Signed: `X-Razorpay-Signature` = HMAC-SHA256(webhook secret, raw body). `payment.captured` → paid; `payment.failed` → `attempt_failed` (the order stays pending: the person may retry); others ignored. `401 INVALID_SIGNATURE`. With Razorpay on, `POST /payments/fake/:orderId` → `404 FAKE_PAYMENTS_OFF`.

## Refunds

Orders carry `refund`: `null`, or `{ "status": "pending" | "refunded", "amountPaise", "reason", "refundedAt" }`.

### `GET /admin/refunds?status=pending|refunded` → `200 { "refunds": [ { "id", "orderId", "userEmail", "eventName", "amountPaise", "reason", "status", "provider", "paymentId", "providerRefundId", "error", "attempts", "createdAt", "refundedAt" } ] }` (pending first)
### `POST /admin/refunds/:id/retry` → `202 { "retried": true }` · `404 REFUND_NOT_FOUND` · `409 ALREADY_REFUNDED`

## Admins run the sale

Admins → `403 ADMINS_CANNOT_BUY` on `POST /events/:id/holds`, `POST /events/:id/queue`, `POST /orders`, `POST /payments/fake/:orderId`; `403 ADMINS_USE_INBOX` on `POST /support/requests` and `POST /support/requests/:id/messages`. See [20](20-admin-side.md).

### `GET /admin/events` → `200 { "events": [ { …event, "status": "upcoming" | "on_sale" | "all_held" | "sold_out", "sold", "held", "available", "revenuePaise", "paidOrders", "inLine", "luckyDraw": null | { "tickets", "left", "entered", "open" } } ], "serverTime" }`
### `GET /admin/events/:id` → `200 { "event": { …the same } }` · `404 EVENT_NOT_FOUND`
### `PATCH /admin/events/:id`
Body: any of `{ "name", "pricePaise", "saleStartsAt", "admissionPerSecond" (null = no waiting room), "lobbyMinutes" }` → `200 { "event" }` · `400` (nothing to change, invalid) · `409 SALE_STARTED` (after the sale opened only the name may change) · `409 LOTTERY_NEEDS_ROOM`
### `GET /admin/notifications` → `200 { "count", "latest": [ restriction… ] }` (automatic restrictions no admin has marked as seen)
### `POST /admin/restrictions/acknowledge` → `200 { "acknowledged": n }`

## Moderation (bot strikes)

Booking actions (`POST /events/:id/holds`, `POST /events/:id/queue`, `POST /orders`, `POST /payments/fake/:orderId`) of a suspended or banned account → `403 ACCOUNT_RESTRICTED` with `details: { kind: "suspended" | "banned", until, reason }`. `GET /auth/me` and `POST /auth/login` return `user.restriction` (`null` or `{ id, kind, until, reason, since }`). Appeals: `POST /support/requests` with `{ "kind": "appeal", "message" }` (`409 NOT_RESTRICTED` if there's nothing to appeal); an admin approving it overturns the restriction. See [18](18-bot-strikes.md).

Admins:

### `GET /admin/restrictions?active=true|false` → `200 { "restrictions": [ { "id", "userId", "userEmail", "kind", "reason", "evidence", "startsAt", "endsAt", "automatic", "liftedAt", "overturned" } ] }`
### `POST /admin/restrictions`
Body `{ "email", "kind": "suspended" | "banned", "days": 1–365 (default 15), "reason" }` → `201 { "restriction" }` · `404 USER_NOT_FOUND` · `409 CANNOT_RESTRICT_SELF`
### `POST /admin/restrictions/:id/lift`
Body `{ "reason", "overturn": false }` (`true` = it was a mistake: doesn't count as a strike) → `200 { "restriction" }` · `404 RESTRICTION_NOT_FOUND` · `409 NOT_IN_FORCE`

## Trying it with curl

```bash
# log in, keep cookies in a jar, then use them
curl -c jar.txt -H "Content-Type: application/json" \
     -d '{"email":"ann@example.com","password":"correct horse battery staple"}' \
     http://localhost:5000/api/auth/login
curl -b jar.txt http://localhost:5000/api/auth/me
curl -b jar.txt -H "Content-Type: application/json" -d '{"quantity":2}' http://localhost:5000/api/events/1/holds
```
