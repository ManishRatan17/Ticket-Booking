# 24 · Train booking

Its own module, separate from bus and from the flash-sale events: [server/src/modules/train/](../server/src/modules/train/) (routes, controller, service, repository, schemas, **providers**) and its own tables ([migration 017](../server/migrations/017_train.sql)). It shares only the general tools (sign-in, validation, errors, rate limits, the Idempotency-Key middleware, the admin guard, the audit log).

## Where trains come from: the provider

| `TRAIN_PROVIDER` | What happens |
|---|---|
| `local` (default) | **the platform's own trains**, added by admins, booked in our database ([providers/local.js](../server/src/modules/train/providers/local.js)) |
| `external` | a licensed train-booking partner ([providers/external.js](../server/src/modules/train/providers/external.js)). Without `TRAIN_PROVIDER_URL` + `TRAIN_PROVIDER_API_KEY` → every train request answers **`503 TRAIN_PROVIDER_NOT_CONFIGURED`**; with them → **`501 TRAIN_PROVIDER_NOT_IMPLEMENTED`** (the adapter needs the partner's API contract). Never invented trains, availability or confirmations. Admins can't add local trains then (`409 TRAIN_INVENTORY_EXTERNAL`) |

**Why not Indian Railways directly:** there is no public booking API. IRCTC sells e-tickets itself or through licensed agents and partners; unlicensed resale was ruled unauthorised (RailYatri, 2019, before it got a licence). Sources: [IRCTC agents](https://irctctourism.com/TravelAgents/InternetTicketingAgents.html), [Rail Travellers' Service Agents Rules 2014](https://www.casemine.com/act/in/5f5f115a9fca195c05cce2b8), [MediaNama](https://www.medianama.com/2019/04/223-railyatri-applies-for-licence-to-sell-train-tickets-after-defeat-in-high-court/). When a partner is chosen, its adapter goes in `providers/external.js` using [lib/httpClient.js](../server/src/lib/httpClient.js) (timeouts, retries only for safe requests, 502/503/504 errors).

| Variable | Default | Meaning |
|---|---|---|
| `TRAIN_PROVIDER` | `local` | `local` or `external` (anything else: the server refuses to start) |
| `TRAIN_PROVIDER_URL` | empty | the partner's API base URL |
| `TRAIN_PROVIDER_API_KEY` | empty | the partner's key (a secret: environment only, never in git) |
| `TRAIN_PROVIDER_TIMEOUT_MS` | `8000` | per-request timeout for the partner (min 1000) |

## The flow (local provider)

Like real train booking, **you choose a class and how many travellers; the server allocates the berths.**

```
search  GET /api/train/trips?from=Mumbai&to=Pune&date=2026-12-01[&classCode=3A]
            → trips with each class: fare, total, available
hold    POST /api/train/trips/:id/holds  { classCode: "3A", travellers: 2 }  + Idempotency-Key
            → 'held' 10 min, berths allocated in order: B1-1, B1-2
confirm POST /api/train/bookings/:id/confirm  { passengers: [{ name, age, gender }, …], contactPhone? }
            → 'confirmed' + a 10-digit PNR (traveller 1 → the first berth, …)
cancel  POST /api/train/bookings/:id/cancel  → 'cancelled', the berths are free again
history GET /api/train/bookings  ·  GET /api/train/bookings/:id
```

Classes: `1A` (berths H1-…), `2A` (A…), `3A` (B…), `SL` (S…), `CC` (C…), `2S` (D…). Up to 6 travellers per booking.

## Guarantees and how they're made

| Guarantee | How |
|---|---|
| **A berth is never in two active bookings** | unique index (trip, berth) over active berths: the database refuses a second. Measured: with the trip lock removed, still no double booking |
| **The train fills up correctly under a rush** | the trip row is locked while berths are allocated, so each request sees what the previous one took. Measured: without the lock, everyone computes the same "first free berth", the index refuses all but one, and only **3 of 10** berths were sold to 30 people. With it: exactly 10 |
| A retried request never makes a second booking | Idempotency-Key, `UNIQUE (user, key)`, checked after the lock; a duplicate-key error becomes "that same booking" |
| No hoarding | ≤ 6 travellers, one **held** booking per person per trip, holds run out after 10 minutes (freed at once; marked expired by the next hold) |
| Price and berths can't be chosen by the client | fare × travellers and the berths come from the database |
| A PNR is unique | random 10 digits, `UNIQUE`; on the (1 in 9 billion) clash the confirmation is retried |
| One lock order | trip, then booking, everywhere (no deadlocks) |

## Endpoints

| Method and path | Who | Answers |
|---|---|---|
| `GET /api/train/trips?from&to&date&classCode?` | anyone | `200 { trips: [{ id, trainNumber, trainName, from, to, departsAt, arrivesAt, cancelledAt, classes: [{ code, farePaise, total, available }] }] }` · `400` · `503`/`501` (external) |
| `GET /api/train/routes` | anyone | `200 { routes: [{ from, to, trips, nextDeparture }] }` (the search suggestions) · `503` (external provider) |
| `GET /api/train/trips/:id` | anyone | `200 { trip }` · `404 TRAIN_TRIP_NOT_FOUND` |
| `POST /api/train/trips/:id/holds` | signed-in customer + `Idempotency-Key` | `201 { booking }` · `200` + `Idempotent-Replayed` · `400 CLASS_NOT_OFFERED` (`details.classes`) / validation · `409 NOT_ENOUGH_BERTHS` (`details.available`) · `409 TRAIN_HOLD_EXISTS` · `409 TRAIN_TRIP_DEPARTED` / `TRAIN_TRIP_CANCELLED` · `422 IDEMPOTENCY_KEY_REUSED` · `400 IDEMPOTENCY_KEY_REQUIRED` · `403 ADMINS_CANNOT_BUY` / `ACCOUNT_RESTRICTED` |
| `POST /api/train/bookings/:id/confirm` | the owner | `200 { booking }` with `pnr` (twice: the same PNR) · `400 PASSENGERS_MISMATCH` (`details.travellers`) · `409 TRAIN_HOLD_EXPIRED` · `409 TRAIN_BOOKING_NOT_HELD` · `404` |
| `POST /api/train/bookings/:id/cancel` | the owner | `200 { booking }` · `409 TRAIN_BOOKING_NOT_ACTIVE` · `409 TRAIN_TRIP_DEPARTED` · `404` |
| `GET /api/train/bookings` · `/:id` | signed in | `200 { bookings }` (newest first) · `200 { booking }` · `404 TRAIN_BOOKING_NOT_FOUND` |
| `POST /api/admin/train/trips` | admin | `{ trainNumber (4–5 digits), trainName, from, to, departsAt, arrivesAt, classes: [{ code, farePaise, coaches (1–24), berthsPerCoach (1–80) }] }` → `201 { trip }`; audited `train.trip.create` · `400` · `409 TRAIN_INVENTORY_EXTERNAL` |
| `GET /api/admin/train/trips` | admin | `200 { trips }` |

A booking: `{ id, status, pnr, classCode, trip: { id, trainNumber, trainName, from, to, departsAt, arrivesAt, cancelled }, travellers: [{ berth, passenger: { name, age, gender } | null }], amountPaise, heldUntil (only while held), contactPhone, confirmedAt, cancelledAt, createdAt }`.

## Tables (migration 017)

| Table | Holds |
|---|---|
| `train_trips` | train number and name, origin, destination, departs / arrives (checks as for buses), cancelled_at, created_by |
| `train_trip_classes` | (trip, class) → fare and `berth_labels TEXT[]` in allocation order |
| `train_bookings` | trip, user, class, status, amount, idempotency key (`UNIQUE (user, key)`), held_until, `pnr UNIQUE`, contact phone, timestamps; one `held` per (trip, user) |
| `train_booking_berths` | booking, trip, berth, position (which traveller), `active`, passenger name / age / gender. **Unique (trip_id, berth_label) WHERE active** |

## Not done yet (honest list)

- **A real train provider:** needs a licensed partner and its API contract (see above).
- Admins can't yet edit or cancel a train trip; no website pages for train booking yet (backend only, as asked).

*Tested in [train.test.js](../server/test/train.test.js) (10 tests). Mutations: no trip lock → both rush tests fail (only 3 of 10 berths sold; no double booking); no lock **and** no unique berth index → both fail; the external provider answering `[]` instead of 503 → the provider test fails.*


**Payment (step 4):** a train booking with a fare is confirmed by **paying**, not by the passenger details: see [12 · Paying for bus and train bookings](12-orders-and-payments.md#paying-for-bus-and-train-bookings). Cancelling a paid booking refunds it. The PNR is given when the payment arrives.