-- 001: initial schema for the flash-sale ticketing system.
-- Postgres is the source of truth: if Redis and Postgres ever disagree, Postgres wins.
-- Constraints below are the LAST line of defence: even if application code has a bug,
-- the database refuses data that breaks these rules.

CREATE TABLE users (
  id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  email         TEXT        NOT NULL UNIQUE,          -- stored lowercased by the app
  password_hash TEXT        NOT NULL,                 -- never store plain passwords
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE events (
  id             BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name           TEXT        NOT NULL,
  total_tickets  INTEGER     NOT NULL CHECK (total_tickets > 0),
  sale_starts_at TIMESTAMPTZ NOT NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE orders (
  id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id         BIGINT      NOT NULL REFERENCES users(id),
  event_id        BIGINT      NOT NULL REFERENCES events(id),
  quantity        INTEGER     NOT NULL CHECK (quantity > 0),
  -- Lifecycle: pending -> paid | failed | expired
  status          TEXT        NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending', 'paid', 'failed', 'expired')),
  -- Sent by the client with the request; a retried request reuses the same key,
  -- so the same user can never accidentally create the same order twice.
  idempotency_key TEXT        NOT NULL,
  payment_id      TEXT,                               -- filled in once payment is confirmed
  expires_at      TIMESTAMPTZ NOT NULL,               -- when the ticket hold runs out
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, idempotency_key)
);

-- Speeds up "orders for this user" and "pending orders for this event" lookups.
CREATE INDEX orders_user_id_idx         ON orders (user_id);
CREATE INDEX orders_event_id_status_idx ON orders (event_id, status);

CREATE TABLE sold_tickets (
  id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  event_id      BIGINT      NOT NULL REFERENCES events(id),
  ticket_number INTEGER     NOT NULL CHECK (ticket_number > 0),
  order_id      BIGINT      NOT NULL REFERENCES orders(id),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- THE safety net of the whole project: one ticket number per event can exist only once.
  -- Two orders can never both own ticket #57 of event 1.
  UNIQUE (event_id, ticket_number)
);

CREATE INDEX sold_tickets_order_id_idx ON sold_tickets (order_id);

-- Payment providers can deliver the same webhook more than once.
-- We record each one we handle; a repeat hits the PRIMARY KEY and is ignored.
CREATE TABLE processed_webhooks (
  webhook_id  TEXT        PRIMARY KEY,                -- the provider's unique event ID
  provider    TEXT        NOT NULL,
  received_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
