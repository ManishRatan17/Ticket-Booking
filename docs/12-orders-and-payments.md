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

## Refunds

Until now, four situations only printed `[refund] … refund it` in the log: money taken, no tickets, and nothing sent back. With real payments that matters. Now every such payment is **refunded** and **on record** ([refunds.js](../server/src/modules/payments/refunds.js), migration [013](../server/migrations/013_refunds.sql)).

| Reason | When |
|---|---|
| `sold_out_after_expiry` | paid after the hold expired, and the tickets had sold out by then |
| `purchase_limit` | the payment would take the person over their limit |
| `amount_mismatch` | a different amount was paid than the order's: **what was paid** goes back |
| `order_already_failed` | a payment for an order that had already failed |
| `event_cancelled` | the admin cancelled the event (see below) |

```
payment transaction ──► refunds row (INSIDE the same transaction, UNIQUE per payment)
after the commit ─────► job "process-refund" (worker; retried with growing pauses)
                         locks the row · Razorpay: ASK "already refunded?" (by our refund id), else refund
                         ──► 'refunded' + an email "₹998.00 refunded for …, because …"
                         failure ──► stays 'pending' with the error (Refunds page: Retry)
```

| Rule | Why |
|---|---|
| Recorded **in the payment transaction** | "the order failed" and "this money is owed back" are written together, or not at all |
| `UNIQUE (payment_id)` | however many deliveries, retries or admins: one refund per payment (tested) |
| **Ask first**, then refund (Razorpay: `GET /payments/:id/refunds`, our refund id in `notes`) | if Razorpay refunded but its answer got lost (a timeout), a retry must not refund again. Tested: a lost answer, then a retry → refunded **once** (mutation: without the check, twice) |
| The row is locked while it's processed (`SELECT … FOR UPDATE`) | the worker's retry and an admin's Retry can't refund at the same moment |
| Failures keep the error and the attempt count | admins see why on the Refunds page; BullMQ retries 5 times, then the dead-letter queue (System page) |

**People** see it in My orders: "refunded ₹998.00 (paid after the hold expired; sold out by then)", and get an email. **Admins:** the **Refunds** page (pending first, with the provider's error and Retry).

*Tested in [refunds.test.js](../server/test/refunds.test.js) (fake provider: recorded with the payment, refunded, email, shown in the order; the same payment twice → one refund; a wrong amount → the paid amount back; the admin list, Retry, 409 when already refunded, 403 for users) and [razorpay.test.js](../server/test/razorpay.test.js) (Razorpay's refund API with the amount and our refund id; Razorpay down → pending with the error, a retry refunds; a lost answer → refunded once).*

## Cancelling an event

An admin cancels an event on its admin page, with a reason (`POST /api/admin/events/:id/cancel`, [events.cancel.js](../server/src/modules/events/events.cancel.js), migration [015](../server/migrations/015_event_cancellation.sql)). **Nothing is deleted**: the event and its orders stay, as the record of who paid what.

```
ONE transaction:  lock the event's open orders (pending + paid)  ─►  events.cancelled_at = now()
                  paid orders    → 'cancelled' + a refund row each (event_cancelled)
                  pending orders → 'cancelled' (nothing was paid)
after the commit: forget the cached event · drop the waiting room · release the held tickets
                  process the refunds (jobs, retried) · email everyone who had paid
```

| What | How |
|---|---|
| The sale stops | holds, orders, joining or watching the queue → `409 EVENT_CANCELLED` (the shop page shows "This event has been cancelled" with the reason) |
| Unpaid orders end | they become `cancelled`; their holds are released |
| **Everyone who paid gets the money back** | a refund per paid order, recorded **in the same transaction** as the cancel: the event can't be cancelled with a refund forgotten. Processed like every refund (above): retried, Refunds page, email |
| Ticket holders are told | an email "Cancelled: …" with the reason and the amount being refunded (then the refund's own email) |
| Background work stops | the admission job skips it (and drops its room), the lucky draw draws nobody |
| No edits afterwards | `PATCH` → `409 EVENT_CANCELLED`; cancelling twice → `409 ALREADY_CANCELLED` |
| Free tickets | nothing paid → nothing refunded (no refund row for ₹0), still emailed |

**Payments racing the cancel.** A person may be paying at the very moment the admin cancels. Two rules make every outcome safe:

1. **Lock order.** Payments lock the order, then the event. The cancel does the same: the orders first, the event row **last**. Taken the other way round, a payment and a cancel each wait for the other: a **deadlock**. Measured: with the cancel locking the event first, PostgreSQL reported "deadlock detected" in 6 of 8 runs of the race test; with the right order, never.
2. **The payment checks under the event lock.** `lockEvent` returns `cancelledAt` read under that lock. Cancelled → the order becomes `cancelled` and the money goes back (`event_cancelled`), no tickets. So an order that slipped in just before the cancel (the cancel didn't see it) is still caught when its payment arrives. A payment for an order the cancel already ended is refunded the same way.

Either the payment finished first (paid → then cancelled and refunded by the cancel), or the cancel did (the payment is refunded). Either way: **one refund per payment, no tickets for a cancelled event.**

*Tested in [cancel-event.test.js](../server/test/cancel-event.test.js): 2 paid + 1 pending order + 1 hold → paid ones cancelled and refunded, emailed (with the reason and amount), the pending one cancelled with no refund, new holds and orders from an old hold → 409, the shop and admin show it; twice → 409, unknown → 404, short reason → 400, no edits, admins only, the audit entry; a payment for an order that slipped in → refunded, no tickets; **8 payments racing the cancel, 3 rounds** → nothing stays paid, exactly one refund each, no deadlock; the waiting room is emptied and closed. Mutations: holds not checking cancellation → the first test fails; the payment ignoring a cancelled event → the slipped-in test fails; the cancel locking the event first → the race test fails with "deadlock detected", 3 of 3 runs.*

## Paying for bus and train bookings

Bus ([23](23-bus-booking.md)) and train ([24](24-train-booking.md)) bookings use **one shared payment flow**, [modules/booking-payments/](../server/src/modules/booking-payments/) (migration [018](../server/migrations/018_booking_payments.sql)). Each module plugs in with a small adapter ([bus.payments.js](../server/src/modules/bus/bus.payments.js), [train.payments.js](../server/src/modules/train/train.payments.js): its tables, the receipt, and for trains the PNR); the shared module never imports them, so the two stay isolated. The event orders' payments above are unchanged.

```
hold (10 min) ──► POST /api/{bus|train}/bookings/:id/confirm  { passengers }   (saved; still 'held')
   ──► POST /api/{bus|train}/bookings/:id/pay/fake {outcome}  → the fake provider's signed webhook
                                                               POST /api/webhooks/booking-payments/{bus|train}
       or POST …/pay/razorpay → checkout → POST …/pay/razorpay/verify  (+ Razorpay's own webhook)
   ──► 'confirmed' (a train gets its PNR now) + a receipt email
```

A **free** trip (fare 0) is confirmed by the passenger details alone; nothing to pay.

| Rule | How |
|---|---|
| Only a payment confirms a booking with a fare | the signed webhook, or Razorpay's verified signature; never the browser's word |
| Each delivery is handled once | its id goes into `processed_webhooks` (atomic insert); a repeat → `duplicate` |
| No race between payments, holds and cancels | the payment transaction locks the **trip, then the booking**, the same order as holds and cancels. Measured: without these locks, 10 deliveries + a second payment at once were not handled correctly (the race test fails) |
| Money that buys nothing goes back, once | a refund recorded **inside** the payment transaction (`UNIQUE (payment_id)`), processed by the refund job: a second payment for a paid booking, a payment for a cancelled one (`booking_not_payable`), a wrong amount (`amount_mismatch`: the booking stays payable) |
| A payment after the hold ran out | other run-out holds give their seats back first; if this booking's seats are still free → **confirmed**; if someone else holds them → `expired` + refunded (`seats_unavailable`) |
| Cancelling a paid booking refunds it | `booking_cancelled`, recorded in the cancel's transaction; the booking shows `refund`, the person gets an email |
| A failed attempt changes nothing | the person can pay again while the hold lasts (as with Razorpay's `payment.failed`) |

Refunds can now belong to an event order **or** a booking: `refunds.order_id` became optional, with `booking_kind` + `booking_id` and a CHECK that exactly one is set. The admin Refunds list and the refund email name the item ("Bus Pune → Goa", "Train 12123 Mumbai → Pune").

**Endpoints** (both kinds; signed in, customers only, not restricted, 10/min): `POST /api/{bus|train}/bookings/:id/pay/fake` `{ outcome: "success" | "failure" }` → `202 { paymentId }` · `POST …/pay/razorpay` → `200 { keyId, razorpayOrderId, amountPaise, currency, description }` (one Razorpay order per booking) · `POST …/pay/razorpay/verify` → `200 { outcome }`. Errors: `409 PASSENGERS_REQUIRED`, `409 BOOKING_ALREADY_PAID`, `409 BOOKING_NOT_PAYABLE`, `409 NOTHING_TO_PAY`, `409 BUS_HOLD_EXPIRED` / `TRAIN_HOLD_EXPIRED`, `404 FAKE_PAYMENTS_OFF` / `RAZORPAY_OFF`, `400 PAYMENT_SIGNATURE_INVALID`, `404 BUS_BOOKING_NOT_FOUND` / `TRAIN_BOOKING_NOT_FOUND`. A booking now carries `passengersGiven`, `payment: null | { required, paid, provider, paidAt }` and `refund`.

*Tested in [booking-payments.test.js](../server/test/booking-payments.test.js) (7) and [razorpay.test.js](../server/test/razorpay.test.js) (+2: a bus booking paid via the page's signed answer, a forged one refused; a train booking confirmed by Razorpay's webhook alone with its PNR, the same delivery again → duplicate). Mutations: repeats not ignored → the duplicate test fails; no locks → the race test fails; cancel without refund → the cancel test fails.*
