# 12 · Orders and payments (Phase 2)

From "I'm holding 2 tickets" to "tickets #9 and #10 are mine", without ever selling a ticket twice, charging twice, or trusting the browser about money.

Code: [modules/orders/](../server/src/modules/orders/), [modules/payments/](../server/src/modules/payments/), [consume-hold.lua](../server/src/modules/reservation/lua/consume-hold.lua), migration [004](../server/migrations/004_orders_payments.sql). Frontend: [EventPage](../client/src/pages/EventPage.jsx) (Checkout button), [CheckoutPage](../client/src/pages/CheckoutPage.jsx), [OrdersPage](../client/src/pages/OrdersPage.jsx).

## The whole journey

```
Browser                         Our server                                          Fake provider (in-process)
  │ Hold 2 tickets ─────────────►│ Redis hold (5 min), stock −2
  │ Checkout (Idempotency-Key) ──►│ order 'pending' in Postgres, amount = price × 2, same deadline
  │ Pay ─────────────────────────►│ POST /api/payments/fake/:id ───────────────────────►│ "customer paid"
  │◄─ 202 Accepted ───────────────│                                                      │
  │ (asks every 0.5 s: paid yet?) │◄── POST /api/webhooks/payments, HMAC-signed ─────────│ a moment later
  │                               │   verify signature → ONE transaction:                │ (retries with backoff
  │                               │   record webhook id · lock order · consume hold      │  if we don't answer 2xx)
  │                               │   · ticket numbers · sold_tickets · order 'paid'     │
  │◄── order 'paid', #1 and #2 ───│
```

## Money rules

- **Whole paise, never decimals** (`price_paise`, `amount_paise` are integers). `0.1 + 0.2 ≠ 0.3` in floating point; ₹499.00 is `49900`. Converted to rupees only for display (`formatMoney`).
- **The price comes from the database**, never from the request. An `amountPaise` sent by the browser is ignored (tested).
- **The browser never decides that an order is paid.** It can only *start* a payment. Only a webhook with a valid signature changes an order to `paid`.

## Orders and idempotency (step 2a)

`POST /api/orders` with header `Idempotency-Key` and body `{ holdId }`:

1. **Seen this key before?** Return that same order (`200`, header `Idempotent-Replayed: true`). Checked first, so a retry still works after the order was paid.
2. The hold must exist, be yours, and still be running by **Redis's clock** (`404 HOLD_NOT_FOUND`, `409 HOLD_EXPIRED`).
3. `INSERT … ON CONFLICT (user_id, idempotency_key) DO NOTHING` — atomic: 10 parallel clicks with one key create **one** order (tested; without `ON CONFLICT` the test fails).
4. One order per hold (a partial unique index on `hold_id`): another key for the same hold → `409 ORDER_EXISTS` with the existing order's id (the frontend then opens that order).
5. Same key, different hold → `422 IDEMPOTENCY_KEY_REUSED` (the client is confused; refuse rather than guess).

The browser makes **one random key per hold** (`crypto.randomUUID()`) and re-sends it on every retry of that checkout.

**Lifetimes:** an order's deadline is its hold's deadline. An unpaid order past it becomes `expired` **when someone looks at it** (and its hold is released, so the tickets return) — the Phase 3 worker will do this for everyone.

## The webhook (steps 2b + 2c)

`POST /api/webhooks/payments` — server-to-server, no cookies.

### 1. Signature
`X-Payment-Signature: sha256=<HMAC-SHA256(secret, exact body bytes)>`. The router uses `express.raw` and is mounted **before** the global `express.json()`, because the signature covers the exact bytes: parsing and re-serialising could change spacing or key order. Compared with `timingSafeEqual`. Wrong secret or a body changed after signing → `401 INVALID_SIGNATURE` (both tested).

**The secret** (`PAYMENT_WEBHOOK_SECRET`) is required in production. In development the fake provider lives inside the same process, so a random secret made at startup serves both sides.

### 2. One transaction
| Step | Why |
|---|---|
| `INSERT INTO processed_webhooks … ON CONFLICT DO NOTHING` | each delivery has a unique id; a repeat does nothing (`duplicate`) |
| `SELECT … FOR UPDATE` on the order | two *different* deliveries about one order wait for each other (`already_paid`) |
| `payment.failed` → order `failed` (`payment_failed`) | its hold is released **after** the commit → tickets back on sale |
| amount ≠ order amount → `failed` (`amount_mismatch`), refund logged | never sell for the wrong price |
| **consume the hold in Redis** | its tickets stay out of stock: they're sold now (a *release* would put them back — mutation-tested: oversold) |
| hold already gone (late payment) → take the tickets from stock again (`hold-stock.lua`) | the blueprint's late-payment policy: confirm if still available… |
| …not available → `failed` (`sold_out_after_expiry`), `[refund]` logged | …otherwise refund |
| `UPDATE events SET tickets_sold = tickets_sold + n RETURNING` | ticket numbers, atomically; `CHECK (tickets_sold <= total_tickets)` refuses an oversell |
| insert `sold_tickets`, order `paid` | `UNIQUE (event_id, ticket_number)`: no ticket can have two owners |

**Redis before commit, on purpose.** If the commit failed after the hold was consumed, a few tickets would be missing from stock — an *undersell*, which is safe. The opposite order could leave a live hold whose tickets later return to stock although they were sold — an *oversell*.

### 3. The HTTP answer
`200 { received: true, outcome }` for every handled event — **including business failures** — because a 2xx tells the provider "stop retrying". Only a crash answers `500`, so the provider retries later (and the rolled-back transaction means the retry starts clean). Outcomes: `paid`, `failed`, `refund_needed`, `duplicate`, `already_paid`, `ignored`, `unknown_order`.

## The fake provider ([fake-provider.js](../server/src/modules/payments/fake-provider.js))

Behaves like Razorpay/Stripe where it matters: the browser gets only a payment id (`202 Accepted`); **later** (`FAKE_PAYMENT_DELAY_MS`, default 800 ms) the provider calls our webhook, signed; on a 5xx or network error it **retries up to 4 times with exponential backoff** (0.2 s, 0.4 s, 0.8 s). It calls back the same host the browser used — in development `localhost:5173`, through Vite (verified end to end). In Phase 7 real Razorpay replaces this file; the webhook stays.

## Three safety nets against overselling

1. **Redis Lua scripts** — holds can't take more than the stock.
2. **`events.tickets_sold` with `CHECK (tickets_sold BETWEEN 0 AND total_tickets)`** — the database refuses to number more tickets than exist.
3. **`sold_tickets UNIQUE (event_id, ticket_number)`** — no ticket number can be sold twice.

## Proof (from [payments.test.js](../server/test/payments.test.js) and [orders.test.js](../server/test/orders.test.js))

| Scenario | Result |
|---|---|
| pay → webhook | paid, tickets [1, 2], stock stays reduced, hold consumed |
| same webhook twice / 10 times at once | paid once |
| two different deliveries for one order | one `paid`, one `already_paid` |
| wrong secret / tampered amount | 401, nothing changes |
| late payment, tickets free | confirmed |
| late payment, sold out meanwhile | `failed` + refund logged; the other buyer keeps their hold |
| 20 buyers pay at the same moment | ticket numbers exactly 1–20 |
| 10 parallel checkouts with one key | one order |

## Not done yet

- **Refunds** are only logged (`[refund] …`); a real refund call comes with Razorpay.
- **Live updates:** the checkout page polls every 0.5 s; Phase 4 brings push updates.
- **Automatic expiry** of everyone's holds and orders: Phase 3.
