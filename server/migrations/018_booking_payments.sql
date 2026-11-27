-- 018: PAYING FOR BUS AND TRAIN BOOKINGS (modules/booking-payments). A booking with a fare is confirmed
-- by a payment (the fake provider or Razorpay), not by the passenger details alone. Refunds can now
-- belong to a bus or train booking as well as to an event order.

ALTER TABLE bus_bookings
  ADD COLUMN passengers_at     TIMESTAMPTZ, -- when the passenger details were given (needed before paying)
  ADD COLUMN payment_provider  TEXT CHECK (payment_provider IN ('fake', 'razorpay')),
  ADD COLUMN provider_order_id TEXT UNIQUE, -- the Razorpay order, created once per booking
  ADD COLUMN payment_id        TEXT UNIQUE, -- the payment that confirmed it
  ADD COLUMN paid_at           TIMESTAMPTZ;

ALTER TABLE train_bookings
  ADD COLUMN passengers_at     TIMESTAMPTZ,
  ADD COLUMN payment_provider  TEXT CHECK (payment_provider IN ('fake', 'razorpay')),
  ADD COLUMN provider_order_id TEXT UNIQUE,
  ADD COLUMN payment_id        TEXT UNIQUE,
  ADD COLUMN paid_at           TIMESTAMPTZ;

-- A refund belongs to EITHER an event order OR a bus/train booking.
ALTER TABLE refunds ALTER COLUMN order_id DROP NOT NULL;
ALTER TABLE refunds
  ADD COLUMN booking_kind TEXT CHECK (booking_kind IN ('bus', 'train')),
  ADD COLUMN booking_id   BIGINT, -- no foreign key: it points into bus_bookings or train_bookings
  ADD CONSTRAINT refunds_one_target CHECK (
    (order_id IS NOT NULL AND booking_kind IS NULL AND booking_id IS NULL)
    OR (order_id IS NULL AND booking_kind IS NOT NULL AND booking_id IS NOT NULL));
CREATE INDEX refunds_booking_idx ON refunds (booking_kind, booking_id) WHERE booking_id IS NOT NULL;

ALTER TABLE refunds DROP CONSTRAINT refunds_reason_check;
ALTER TABLE refunds ADD CONSTRAINT refunds_reason_check CHECK (reason IN (
  'sold_out_after_expiry', 'purchase_limit', 'amount_mismatch', 'order_already_failed', 'event_cancelled',
  'booking_cancelled',    -- the customer cancelled a paid bus/train booking
  'seats_unavailable',    -- paid after the hold ran out, and the seats were taken by then
  'booking_not_payable')); -- paid for a booking that was already cancelled, or already paid
