-- 004: orders and payments (Phase 2).

-- Prices are whole PAISE (₹1 = 100 paise), never decimals: 0.1 + 0.2 ≠ 0.3 in floating point.
-- tickets_sold is the per-event counter that hands out ticket numbers:
--   UPDATE events SET tickets_sold = tickets_sold + 2 … RETURNING tickets_sold   → numbers 9 and 10
-- and the CHECK makes the DATABASE refuse to sell more tickets than exist — a third safety net
-- after the Redis Lua scripts and UNIQUE (event_id, ticket_number).
ALTER TABLE events
  ADD COLUMN price_paise  INTEGER NOT NULL DEFAULT 0 CHECK (price_paise >= 0),
  ADD COLUMN tickets_sold INTEGER NOT NULL DEFAULT 0;

-- Existing events: count what is already in sold_tickets (normally nothing yet).
UPDATE events AS e
   SET tickets_sold = (SELECT count(*) FROM sold_tickets AS s WHERE s.event_id = e.id);

ALTER TABLE events
  ADD CONSTRAINT events_tickets_sold_within_total CHECK (tickets_sold BETWEEN 0 AND total_tickets);

ALTER TABLE orders
  ADD COLUMN hold_id        UUID,                         -- the Redis hold this order pays for
  ADD COLUMN amount_paise   INTEGER NOT NULL DEFAULT 0 CHECK (amount_paise >= 0),
  ADD COLUMN paid_at        TIMESTAMPTZ,
  ADD COLUMN failure_reason TEXT;                         -- e.g. payment_failed, sold_out_after_expiry

-- One order per hold, whatever idempotency key the client sends.
CREATE UNIQUE INDEX orders_hold_id_key ON orders (hold_id) WHERE hold_id IS NOT NULL;
