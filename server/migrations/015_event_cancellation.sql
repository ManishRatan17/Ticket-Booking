-- 015: CANCELLING AN EVENT. The event stays (it's the record of who paid what); it is marked cancelled,
-- its orders become 'cancelled', and every paid order gets a refund (reason event_cancelled, migration 013).
ALTER TABLE events
  ADD COLUMN cancelled_at  TIMESTAMPTZ,   -- NULL = not cancelled
  ADD COLUMN cancel_reason TEXT;          -- what the admin wrote; shown to customers

-- A new order status: 'cancelled' (the event was cancelled; paid ones are refunded).
ALTER TABLE orders DROP CONSTRAINT orders_status_check;
ALTER TABLE orders ADD CONSTRAINT orders_status_check
  CHECK (status IN ('pending', 'paid', 'failed', 'expired', 'cancelled'));
