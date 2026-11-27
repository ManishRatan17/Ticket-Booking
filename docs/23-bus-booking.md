# 23 · Bus booking

A booking system of its own, next to the flash-sale events: [server/src/modules/bus/](../server/src/modules/bus/) with its own routes, controller, service, repository (SQL), validation and tables ([migration 016](../server/migrations/016_bus.sql)). It shares only the platform's general tools: sign-in, validation, errors, rate limits, the Idempotency-Key middleware, the admin guard and the audit log. A change in one booking system can't break the other.

**Trips are the platform's own inventory**, added by admins. Nothing comes from an outside provider, so there is no external dependency, credential or environment variable for buses. **Payment:** a trip with a fare is confirmed by paying (step 4, below); a free trip by the passenger details.

## The flow

```
search  GET /api/bus/trips?from=Pune&to=Goa&date=2026-12-01   (any letter case; the date is a day in India)
seats   GET /api/bus/trips/:id                                 seat map: each seat taken or free (never who)
hold    POST /api/bus/trips/:id/holds  { seats: ["1A","1B"] }  + Idempotency-Key  → booking 'held' for 10 min
confirm POST /api/bus/bookings/:id/confirm  { passengers: [{ seat, name, age, gender }], contactPhone? }
                                                               → 'confirmed'
cancel  POST /api/bus/bookings/:id/cancel                      → 'cancelled', the seats are free again
history GET /api/bus/bookings  ·  GET /api/bus/bookings/:id
```

```
held ──confirm──► confirmed ──cancel──► cancelled
  │ └──cancel──────────────────────────► cancelled
  └── 10 minutes pass ──► expired (its seats are free at once; marked expired by the next hold on that trip)
```

## Guarantees and how they're made

| Guarantee | How |
|---|---|
| **A seat is never in two active bookings**, however many people click at once | **the database refuses it:** a unique index on (trip, seat) over active seats. Measured: with the lock below removed too, both race tests fail (seats double-booked); with the index in place they pass even without the lock |
| Holds on one trip take turns | every change to a trip's bookings locks the **trip row first** (`SELECT … FOR UPDATE`), then the booking: one lock order everywhere, so no deadlocks |
| A retried request (double click, network retry) never makes a second booking | Idempotency-Key header, `UNIQUE (user, key)`; checked after the trip lock; and if parallel retries ever got past it, the duplicate-key error is turned into "here is that same booking" (tested with the lock removed: 9/9 pass) |
| No hoarding | at most 6 seats per booking, one **held** booking per person per trip (unique index), holds run out after 10 minutes |
| The price can't be chosen by the client | fare × seats, read from the trip in the database |
| Expired holds free their seats at once | "taken" means confirmed, or held **and** not yet run out; the next hold on the trip marks overdue holds expired (no background job needed) |
| You only see your own bookings | ownership is part of every query: someone else's booking → 404 (not 403: don't confirm it exists) |
| Bots and admins | holds are rate-limited (per IP and per user), restricted accounts can't book (bot strikes), admins don't book (`ADMINS_CANNOT_BUY`) |

## Endpoints

| Method and path | Who | Answers |
|---|---|---|
| `GET /api/bus/trips?from&to&date` | anyone | `200 { trips: [{ id, operator, busNumber, from, to, departsAt, arrivesAt, farePaise, totalSeats, seatsLeft, cancelledAt }] }` (not yet departed, not cancelled) · `400` (date not YYYY-MM-DD, from = to) |
| `GET /api/bus/routes` | anyone | `200 { routes: [{ from, to, trips, nextDeparture }] }`: upcoming routes (the search form's suggestions), not departed, not cancelled |
| `GET /api/bus/trips/:id` | anyone | `200 { trip: { …, seatsLeft, seats: [{ label, taken }] } }` · `404 BUS_TRIP_NOT_FOUND` |
| `POST /api/bus/trips/:id/holds` | signed-in customer + `Idempotency-Key` | `201 { booking }` · `200` + `Idempotent-Replayed: true` (a retry) · `400 UNKNOWN_SEATS` / validation (1–6 seats like `7C`, no repeats) · `400 IDEMPOTENCY_KEY_REQUIRED` · `409 SEATS_TAKEN` (`details.seats`) · `409 BUS_HOLD_EXISTS` · `409 BUS_TRIP_DEPARTED` / `BUS_TRIP_CANCELLED` · `422 IDEMPOTENCY_KEY_REUSED` · `403 ADMINS_CANNOT_BUY` / `ACCOUNT_RESTRICTED` |
| `POST /api/bus/bookings/:id/confirm` | the booking's owner | `200 { booking }` (confirming twice: the same answer) · `400 PASSENGERS_MISMATCH` (one passenger per held seat; `details.seats`) · `409 BUS_HOLD_EXPIRED` · `409 BUS_BOOKING_NOT_HELD` · `404 BUS_BOOKING_NOT_FOUND` |
| `POST /api/bus/bookings/:id/cancel` | the booking's owner | `200 { booking }` · `409 BUS_BOOKING_NOT_ACTIVE` · `409 BUS_TRIP_DEPARTED` · `404` |
| `GET /api/bus/bookings` · `GET /api/bus/bookings/:id` | signed in | `200 { bookings }` newest first (100) · `200 { booking }` · `404` |
| `POST /api/admin/bus/trips` | admin | body `{ operator, busNumber, from, to, departsAt, arrivesAt, farePaise, rows (1–15), seatColumns ("ABCD", letters A–F) }` → `201 { trip }` with `seatLabels` (`1A … 10D`); audited as `bus.trip.create` · `400` (in the past, from = to, arrives before it leaves, repeated column) |
| `GET /api/admin/bus/trips` | admin | `200 { trips }` (upcoming, with seats left) |

A booking: `{ id, status, trip: { id, operator, busNumber, from, to, departsAt, arrivesAt, cancelled }, seats: [{ label, passenger: { name, age, gender } | null }], amountPaise, heldUntil (only while held), contactPhone, confirmedAt, cancelledAt, createdAt }`.

## Tables (migration 016)

| Table | Holds |
|---|---|
| `bus_trips` | operator, bus number, origin, destination, departs / arrives (`CHECK arrives > departs`, `CHECK origin ≠ destination`), fare, `seat_labels TEXT[]` (1–90), cancelled_at, created_by. Index on (lower(origin), lower(destination), departs_at) for search |
| `bus_bookings` | trip, user, status held/confirmed/cancelled/expired, amount, idempotency key (`UNIQUE (user_id, idempotency_key)`), held_until, contact phone, timestamps. Unique index: one `held` per (trip, user) |
| `bus_booking_seats` | booking, trip, seat, `active`, passenger name / age (1–120) / gender. **Unique index (trip_id, seat_label) WHERE active** |

## Not done yet (honest list)

- Admins can't yet edit or cancel a trip (cancelling one will need refunds once payment exists).
- No website pages for bus booking yet (backend only, as asked); the Bus card still lists events.
- Expired holds are marked `expired` when the next hold on that trip happens; their seats are free immediately either way.

*Tested in [bus.test.js](../server/test/bus.test.js) (9 tests). Mutations: no trip lock → the 10-retries-at-once test failed (fixed: duplicate-key fallback; now passes even without the lock); no lock **and** no unique seat index → both seat races fail (double bookings); overdue holds never expired → the expiry test fails.*


**Payment (step 4):** a bus booking with a fare is confirmed by **paying**, not by the passenger details: see [12 · Paying for bus and train bookings](12-orders-and-payments.md#paying-for-bus-and-train-bookings). Cancelling a paid booking refunds it.