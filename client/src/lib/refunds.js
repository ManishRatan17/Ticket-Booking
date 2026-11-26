// Words for why a refund happened (server: modules/payments/refunds.js).
export const REFUND_REASON_TEXT = {
  sold_out_after_expiry: 'paid after the hold expired; sold out by then',
  purchase_limit: 'over the per-person ticket limit',
  amount_mismatch: 'paid a different amount than the order',
  order_already_failed: 'paid for an order that had already failed',
  event_cancelled: 'the event was cancelled',
}
