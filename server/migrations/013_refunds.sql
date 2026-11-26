-- 013: REFUNDS. Money that was taken but bought no tickets goes back, and every refund is on record.
-- Until now these cases only printed "[refund] … refund it" in the log.
CREATE TABLE refunds (
  id                 BIGINT      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  order_id           BIGINT      NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  user_id            BIGINT      REFERENCES users(id) ON DELETE SET NULL,
  provider           TEXT        NOT NULL CHECK (provider IN ('fake', 'razorpay')),
  payment_id         TEXT        NOT NULL,
  amount_paise       INTEGER     NOT NULL CHECK (amount_paise > 0),
  reason             TEXT        NOT NULL CHECK (reason IN (
                       'sold_out_after_expiry',  -- paid after the hold expired, and sold out by then
                       'purchase_limit',         -- the payment would go over the per-person limit
                       'amount_mismatch',        -- paid a different amount than the order
                       'order_already_failed',   -- paid for an order that had already failed
                       'event_cancelled')),      -- the admin cancelled the event
  status             TEXT        NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'refunded')),
  provider_refund_id TEXT,                       -- Razorpay's "rfnd_…"
  error              TEXT,                       -- the last attempt's error, while still pending
  attempts           INTEGER     NOT NULL DEFAULT 0,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  refunded_at        TIMESTAMPTZ,
  -- ONE refund per payment: however many deliveries, retries or admins, a payment is never refunded twice.
  UNIQUE (payment_id)
);
CREATE INDEX refunds_status_idx ON refunds (status, created_at);
CREATE INDEX refunds_order_idx ON refunds (order_id);
