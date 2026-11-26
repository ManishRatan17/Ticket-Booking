// SQL for orders. Functions take a `client` (the pool, or a transaction's connection).

// One order with its event name and ticket numbers (empty until paid).
const ORDER_SELECT = `
  SELECT o.id, o.user_id, o.event_id, e.name AS event_name, o.quantity, o.amount_paise, o.status, o.pool,
         o.hold_id, o.idempotency_key, o.payment_id, o.provider_order_id, o.expires_at, o.paid_at, o.failure_reason, o.created_at,
         (SELECT json_build_object('status', rf.status, 'amountPaise', rf.amount_paise, 'reason', rf.reason, 'refundedAt', rf.refunded_at)
            FROM refunds AS rf WHERE rf.order_id = o.id ORDER BY rf.id DESC LIMIT 1) AS refund,
         COALESCE(array_agg(s.ticket_number ORDER BY s.ticket_number)
                  FILTER (WHERE s.ticket_number IS NOT NULL), '{}') AS ticket_numbers
    FROM orders AS o
    JOIN events AS e ON e.id = o.event_id
    LEFT JOIN sold_tickets AS s ON s.order_id = o.id`;

function toOrder(row) {
  return {
    id: Number(row.id),
    userId: Number(row.user_id),
    eventId: Number(row.event_id),
    eventName: row.event_name,
    quantity: row.quantity,
    amountPaise: row.amount_paise,
    status: row.status, // pending → paid | failed | expired; 'cancelled' = the event was cancelled
    pool: row.pool, // 'main' or 'lottery' (lucky-draw tickets)
    holdId: row.hold_id,
    providerOrderId: row.provider_order_id, // Razorpay's order id ("order_…"), once checkout started
    idempotencyKey: row.idempotency_key,
    paymentId: row.payment_id,
    expiresAt: row.expires_at,
    paidAt: row.paid_at,
    failureReason: row.failure_reason,
    createdAt: row.created_at,
    ticketNumbers: row.ticket_numbers,
    refund: row.refund ?? null, // { status: 'pending' | 'refunded', amountPaise, reason, refundedAt } or null
  };
}

async function selectOne(client, where, params) {
  const { rows } = await client.query(`${ORDER_SELECT} WHERE ${where} GROUP BY o.id, e.name`, params);
  return rows.length === 0 ? null : toOrder(rows[0]);
}

export const findOrderById = (client, orderId) => selectOne(client, 'o.id = $1', [orderId]);

// Ownership is part of the query: someone else's order simply isn't found (→ 404, IDOR).
export const findOrderForUser = (client, orderId, userId) =>
  selectOne(client, 'o.id = $1 AND o.user_id = $2', [orderId, userId]);

export const findOrderByIdempotencyKey = (client, userId, key) =>
  selectOne(client, 'o.user_id = $1 AND o.idempotency_key = $2', [userId, key]);

export async function findOrderIdByHold(client, holdId) {
  const { rows } = await client.query('SELECT id FROM orders WHERE hold_id = $1', [holdId]);
  return rows.length === 0 ? null : Number(rows[0].id);
}

export async function listOrdersForUser(client, userId) {
  const { rows } = await client.query(
    `${ORDER_SELECT} WHERE o.user_id = $1 GROUP BY o.id, e.name ORDER BY o.created_at DESC`,
    [userId],
  );
  return rows.map(toOrder);
}

// "Insert unless this user already used this idempotency key." Returns the new order's id,
// or null if the key was taken (by an earlier request, or one racing us right now).
// ON CONFLICT … DO NOTHING is atomic: two parallel requests can't both insert.
export async function insertOrder(
  client,
  { userId, eventId, quantity, amountPaise, holdId, idempotencyKey, expiresAt, pool = 'main' },
) {
  const { rows } = await client.query(
    `INSERT INTO orders (user_id, event_id, quantity, amount_paise, hold_id, idempotency_key, expires_at, pool)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     ON CONFLICT (user_id, idempotency_key) DO NOTHING
     RETURNING id`,
    [userId, eventId, quantity, amountPaise, holdId, idempotencyKey, expiresAt, pool],
  );
  return rows.length === 0 ? null : Number(rows[0].id);
}

// Locks the order row until the transaction ends (the payment webhook uses this, so two
// deliveries of the same payment can't both act on the order).
// Remember the Razorpay order for one of ours. ONLY if it has none yet: two clicks at once create two
// Razorpay orders, but just the first is kept (the other is never paid). Returns the one in effect.
export async function setProviderOrderId(client, orderId, providerOrderId) {
  const { rows } = await client.query(
    `UPDATE orders SET provider_order_id = $2, updated_at = now() WHERE id = $1 AND provider_order_id IS NULL RETURNING provider_order_id`,
    [orderId, providerOrderId],
  );
  if (rows.length) return rows[0].provider_order_id;
  const again = await client.query('SELECT provider_order_id FROM orders WHERE id = $1', [orderId]);
  return again.rows[0]?.provider_order_id ?? null;
}

export async function findOrderIdByProviderOrderId(client, providerOrderId) {
  const { rows } = await client.query('SELECT id FROM orders WHERE provider_order_id = $1', [providerOrderId]);
  return rows.length === 0 ? null : Number(rows[0].id);
}

export async function lockOrder(client, orderId) {
  const { rows } = await client.query('SELECT id, status FROM orders WHERE id = $1 FOR UPDATE', [orderId]);
  return rows[0] ?? null;
}

// Lazy expiry: a pending order past its deadline becomes 'expired'. Returns its hold id
// if this call did the expiring (so the caller can give the held tickets back), else null.
export async function expireIfOverdue(client, orderId) {
  const { rows } = await client.query(
    `UPDATE orders SET status = 'expired', updated_at = now()
      WHERE id = $1 AND status = 'pending' AND expires_at < now()
     RETURNING hold_id`,
    [orderId],
  );
  return rows.length === 0 ? null : rows[0].hold_id;
}

// Used by the expiry WORKER once a hold has expired by Redis's clock: its pending order
// (if any) can't be paid in time any more. Returns the order id if one was expired.
// (If a payment webhook holds the order's row lock right now, this waits for it; if the
// payment won, the order is 'paid' and nothing matches.)
export async function expirePendingOrderForHold(client, holdId) {
  const { rows } = await client.query(
    `UPDATE orders SET status = 'expired', updated_at = now()
      WHERE hold_id = $1 AND status = 'pending'
     RETURNING id`,
    [holdId],
  );
  return rows.length === 0 ? null : Number(rows[0].id);
}

// Tickets this user has PAID for at this event (the purchase cap's source of truth, Phase 5b).
export async function paidQuantityForUser(client, eventId, userId) {
  const { rows } = await client.query(
    `SELECT COALESCE(SUM(quantity), 0)::int AS paid FROM orders WHERE event_id = $1 AND user_id = $2 AND status = 'paid'`,
    [eventId, userId],
  );
  return rows[0].paid;
}

export async function markPaid(client, { orderId, paymentId }) {
  await client.query(
    `UPDATE orders SET status = 'paid', payment_id = $2, paid_at = now(), failure_reason = NULL, updated_at = now()
      WHERE id = $1`,
    [orderId, paymentId],
  );
}

export async function markFailed(client, { orderId, paymentId, reason }) {
  await client.query(
    `UPDATE orders SET status = 'failed', payment_id = COALESCE($2, payment_id), failure_reason = $3, updated_at = now()
      WHERE id = $1`,
    [orderId, paymentId, reason],
  );
}

// The event was cancelled (a payment arriving afterwards): no tickets, and the money goes back.
export async function markCancelled(client, { orderId, paymentId }) {
  await client.query(
    `UPDATE orders SET status = 'cancelled', payment_id = COALESCE($2, payment_id), failure_reason = 'event_cancelled', updated_at = now()
      WHERE id = $1`,
    [orderId, paymentId],
  );
}

export async function insertSoldTickets(client, { eventId, orderId, ticketNumbers }) {
  await client.query(
    `INSERT INTO sold_tickets (event_id, ticket_number, order_id)
     SELECT $1, unnest($2::int[]), $3`,
    [eventId, ticketNumbers, orderId],
  );
}
