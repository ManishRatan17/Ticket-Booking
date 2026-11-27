-- 016: BUS BOOKING: its own module and its own tables (server/src/modules/bus/).
-- Trips are the platform's own inventory, added by admins. A booking holds seats for 10 minutes,
-- then the passenger details confirm it (payment comes in a later step).

CREATE TABLE bus_trips (
  id           BIGINT      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  operator     TEXT        NOT NULL,
  bus_number   TEXT        NOT NULL,
  origin       TEXT        NOT NULL,
  destination  TEXT        NOT NULL,
  departs_at   TIMESTAMPTZ NOT NULL,
  arrives_at   TIMESTAMPTZ NOT NULL,
  fare_paise   INTEGER     NOT NULL CHECK (fare_paise >= 0),
  seat_labels  TEXT[]      NOT NULL CHECK (cardinality(seat_labels) BETWEEN 1 AND 90), -- e.g. {1A,1B,…,10D}
  cancelled_at TIMESTAMPTZ,
  created_by   BIGINT      REFERENCES users(id) ON DELETE SET NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (arrives_at > departs_at),
  CHECK (lower(origin) <> lower(destination))
);
-- Search: from + to (any letter case) + a day.
CREATE INDEX bus_trips_search_idx ON bus_trips (lower(origin), lower(destination), departs_at);

CREATE TABLE bus_bookings (
  id              BIGINT      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  trip_id         BIGINT      NOT NULL REFERENCES bus_trips(id) ON DELETE CASCADE,
  user_id         BIGINT      NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status          TEXT        NOT NULL DEFAULT 'held'
                  CHECK (status IN ('held', 'confirmed', 'cancelled', 'expired')),
  amount_paise    INTEGER     NOT NULL CHECK (amount_paise >= 0),
  idempotency_key TEXT        NOT NULL,
  held_until      TIMESTAMPTZ NOT NULL,
  contact_phone   TEXT,
  confirmed_at    TIMESTAMPTZ,
  cancelled_at    TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, idempotency_key) -- a retried request can't create a second booking
);
CREATE INDEX bus_bookings_user_idx ON bus_bookings (user_id, created_at DESC);
-- One HELD booking per person per trip (no hoarding seats with several holds).
CREATE UNIQUE INDEX bus_bookings_one_hold_idx ON bus_bookings (trip_id, user_id) WHERE status = 'held';

CREATE TABLE bus_booking_seats (
  booking_id       BIGINT   NOT NULL REFERENCES bus_bookings(id) ON DELETE CASCADE,
  trip_id          BIGINT   NOT NULL REFERENCES bus_trips(id) ON DELETE CASCADE,
  seat_label       TEXT     NOT NULL,
  active           BOOLEAN  NOT NULL DEFAULT true, -- false once its booking is cancelled or expired
  passenger_name   TEXT,
  passenger_age    SMALLINT CHECK (passenger_age BETWEEN 1 AND 120),
  passenger_gender TEXT     CHECK (passenger_gender IN ('female', 'male', 'other')),
  PRIMARY KEY (booking_id, seat_label)
);
-- THE rule: a seat of a trip belongs to at most ONE active booking. The database itself refuses a
-- second one, whatever the code does (the service also checks first, to give a clear answer).
CREATE UNIQUE INDEX bus_seat_taken_once_idx ON bus_booking_seats (trip_id, seat_label) WHERE active;
