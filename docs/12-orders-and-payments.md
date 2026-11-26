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
   **But first:** is there already an order with **this same key**? Then it's a replay, not a conflict. `ON CONFLICT` only covers the key's index; when many requests with one key insert at the same instant, PostgreSQL sometimes reports the clash on the **hold's** index first. We used to answer `ORDER_EXISTS` then: **reproduced ~15 times in 1,200 calls** (a stress script, 20 calls at once), found because a test failed once in a full run. Fixed in Phase "support inbox"; a service-level test (30 rounds × 20 at once, 0 errors allowed) now guards it, and fails with the old code.
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
| `SELECT … FOR UPDATE` on the **event**; paid tickets + this order > 4 → `failed` (`purchase_limit`), refund logged, hold released | the per-person purchase cap's final check (Phase 5b, [15](15-protection.md#5b--purchase-cap-4-tickets-per-person-per-event)) |
| `payment.failed` → order `failed` (`payment_failed`) | its hold is released **after** the commit → tickets back on sale |
| amount ≠ order amount → `failed` (`amount_mismatch`), refund logged | never sell for the wrong price |
| **consume the hold in Redis** (and add its tickets to your `bought` count) | its tickets stay out of stock: they're sold now (a *release* would put them back — mutation-tested: oversold) |
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

## Razorpay, test mode (Phase 7)

With `RAZORPAY_KEY_ID` + `RAZORPAY_KEY_SECRET` set, payments go through **Razorpay** and the fake provider is **switched off** (`404 FAKE_PAYMENTS_OFF`: nobody gets tickets by pressing a fake "Pay"). Without them (development, tests, the load test) the fake provider is used. The page asks `GET /api/config` which one to show.

```
1. "Pay with Razorpay" → POST /api/payments/razorpay/:orderId
      our server → Razorpay: create an ORDER for exactly the order's amount (Basic auth: key id + SECRET)
      stored on our order (provider_order_id); asking again reuses it
2. the page opens Razorpay's own window (their script and iframe): card details never touch us
3. paid → the window gives the page { razorpay_payment_id, razorpay_order_id, razorpay_signature }
      → POST /api/payments/razorpay/:orderId/verify
      the server checks: signature = HMAC-SHA256(KEY SECRET, "order_id|payment_id"), and that the
      Razorpay order is THIS order's  →  the SAME payment transaction as webhooks (below)
4. Razorpay ALSO calls POST /api/webhooks/razorpay, signed with the WEBHOOK SECRET over the raw body
      (X-Razorpay-Signature): payment.captured → paid. The backup if the tab closed before step 3.
```

[razorpay.js](../server/src/modules/payments/razorpay.js) is plain HTTPS + HMAC (no SDK); signatures are compared in constant time.

| Rule | Why |
|---|---|
| Steps 3 and 4 both feed the **same transaction** (processed deliveries, order lock, consume the hold, ticket numbers, late-payment rules, the purchase cap) | one source of truth for "paid", whoever reports it first. Both can arrive: the second finds the order already paid (tested: tickets taken once) |
| The signature must match **and** the Razorpay order must be **this** order's | otherwise a genuinely paid cheap order could be "reused" to pay another (tested: Bob's real payment sent for Ann's order → 400) |
| `payment.failed` doesn't fail the order | it's ONE failed attempt: in Razorpay's window the person can retry with another card at once. Failing the order would turn that retry's success into a refund. If they give up, the order expires after 5 minutes like any unpaid order |
| The amount comes from **our** order (step 3) or Razorpay's payment (step 4), and a mismatch fails the order | never sell for the wrong price (tested) |
| A Razorpay order is created once per our order (`UPDATE … WHERE provider_order_id IS NULL`) | double clicks don't create two payable orders |

**Test mode:** Razorpay's test keys (`rzp_test_…`) take no real money; pay with test UPI `success@razorpay` (`failure@razorpay` to see a failure), or an **Indian** test card such as Visa `4100 2800 0000 1007` (any future date, any CVV, an OTP of 4–10 digits). **International** cards (e.g. `4111 1111 1111 1111`) are refused with "International cards are not supported" unless the Razorpay account enables them. Source: Razorpay's test card and test UPI pages. In the dashboard, make sure payments are **captured automatically** (Account & Settings → Payment capture), otherwise `payment.captured` never comes.

**Content-Security-Policy:** the page may load `https://checkout.razorpay.com` (script) and Razorpay's frames (`api.razorpay.com`, `checkout.razorpay.com`).

*Tested in [razorpay.test.js](../server/test/razorpay.test.js) against a fake Razorpay ([fake-razorpay.js](../server/test-support/fake-razorpay.js), same shapes and signatures): the page gets the public key id, never the secret; the fake provider is off; a Razorpay order for exactly the amount, created once; someone else's order → 404, not pending → 409; a valid signature → paid with ticket numbers, confirming twice → `duplicate`; a forged signature or another order's real payment → 400, still pending; `payment.captured` webhook alone → paid; page + webhook at the same moment → one payment, tickets once; a failed attempt keeps the order pending and a retry pays; wrong webhook signature → 401, the same delivery twice → duplicate, unknown orders / other events ignored; a wrong amount → failed. Mutations: not checking the payment belongs to this order, or accepting any signature → the forged-payment test fails. **Not yet tried with your real test keys** (needs your Razorpay account).*
