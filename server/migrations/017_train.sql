-- 017: TRAIN BOOKING: its own module and tables (server/src/modules/train/). The platform's own trains,
-- added by admins (TRAIN_PROVIDER=local). Booking works like real train booking: choose a class and
-- how many travellers; the SERVER allocates the berths. A confirmed booking gets a PNR.

CREATE TABLE train_trips (
  id           BIGINT      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  train_number TEXT        NOT NULL,                -- e.g. 12123
  train_name   TEXT        NOT NULL,                -- e.g. Deccan Queen
  origin       TEXT        NOT NULL,
  destination  TEXT        NOT NULL,
  departs_at   TIMESTAMPTZ NOT NULL,
  arrives_at   TIMESTAMPTZ NOT NULL,
  cancelled_at TIMESTAMPTZ,
  created_by   BIGINT      REFERENCES users(id) ON DELETE SET NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (arrives_at > departs_at),
  CHECK (lower(origin) <> lower(destination))
);
CREATE INDEX train_trips_search_idx ON train_trips (lower(origin), lower(destination), departs_at);

-- The classes a trip offers (SL, 3A, 2A, 1A, CC, 2S), each with its fare and its berths in
-- allocation order, e.g. 3A: {B1-1, B1-2, …, B2-64}.
CREATE TABLE train_trip_classes (
  trip_id      BIGINT  NOT NULL REFERENCES train_trips(id) ON DELETE CASCADE,
  class_code   TEXT    NOT NULL CHECK (class_code IN ('1A', '2A', '3A', 'SL', 'CC', '2S')),
  fare_paise   INTEGER NOT NULL CHECK (fare_paise >= 0),
  berth_labels TEXT[]  NOT NULL CHECK (cardinality(berth_labels) BETWEEN 1 AND 2000),
  PRIMARY KEY (trip_id, class_code)
);

CREATE TABLE train_bookings (
  id              BIGINT      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  trip_id         BIGINT      NOT NULL REFERENCES train_trips(id) ON DELETE CASCADE,
  user_id         BIGINT      NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  class_code      TEXT        NOT NULL,
  status          TEXT        NOT NULL DEFAULT 'held'
                  CHECK (status IN ('held', 'confirmed', 'cancelled', 'expired')),
  amount_paise    INTEGER     NOT NULL CHECK (amount_paise >= 0),
  idempotency_key TEXT        NOT NULL,
  held_until      TIMESTAMPTZ NOT NULL,
  pnr             TEXT        UNIQUE,              -- 10 digits, given when the booking is confirmed
  contact_phone   TEXT,
  confirmed_at    TIMESTAMPTZ,
  cancelled_at    TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, idempotency_key),
  FOREIGN KEY (trip_id, class_code) REFERENCES train_trip_classes (trip_id, class_code) ON DELETE CASCADE
);
CREATE INDEX train_bookings_user_idx ON train_bookings (user_id, created_at DESC);
-- One HELD booking per person per trip.
CREATE UNIQUE INDEX train_bookings_one_hold_idx ON train_bookings (trip_id, user_id) WHERE status = 'held';

CREATE TABLE train_booking_berths (
  booking_id       BIGINT   NOT NULL REFERENCES train_bookings(id) ON DELETE CASCADE,
  trip_id          BIGINT   NOT NULL REFERENCES train_trips(id) ON DELETE CASCADE,
  berth_label      TEXT     NOT NULL,
  position         SMALLINT NOT NULL,              -- 1..6: which traveller of the booking
  active           BOOLEAN  NOT NULL DEFAULT true, -- false once its booking is cancelled or expired
  passenger_name   TEXT,
  passenger_age    SMALLINT CHECK (passenger_age BETWEEN 1 AND 120),
  passenger_gender TEXT     CHECK (passenger_gender IN ('female', 'male', 'other')),
  PRIMARY KEY (booking_id, berth_label)
);
-- THE rule: a berth of a trip belongs to at most ONE active booking. The database refuses a second.
CREATE UNIQUE INDEX train_berth_taken_once_idx ON train_booking_berths (trip_id, berth_label) WHERE active;
