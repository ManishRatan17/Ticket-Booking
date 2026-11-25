// Payments: from "the provider says it's paid" to tickets with numbers.
import { pool, withTransaction } from '../../config/db.js';
import { AppError } from '../../lib/errors.js';
import { addBought, consumeHold, releaseHold } from '../reservation/holds.js';
import { purchaseLimitFor } from '../reservation/purchaseLimit.js';
import { holdTickets as takeFromStock } from '../reservation/stock.js';
import { ensureStock } from '../events/events.service.js';
import * as eventsRepository from '../events/events.repository.js';
import * as ordersRepository from '../orders/orders.repository.js';
import { startPayment } from './fake-provider.js';
import { sendMail } from '../../lib/mailer.js';
import { formatRupees } from '../../lib/money.js';

// ---------------------------------------------------------------------------
// Starting a (fake) payment — called by the browser's "Pay" button
// ---------------------------------------------------------------------------

export async function startFakePayment({ orderId, userId, outcome, webhookUrl }) {
  const order = await ordersRepository.findOrderForUser(pool, orderId, userId);
  if (!order) throw new AppError(404, 'ORDER_NOT_FOUND', 'No order with this id');
  if (order.status !== 'pending') {
    throw new AppError(409, 'ORDER_NOT_PENDING', `This order is already ${order.status}`, { status: order.status });
  }
  // Note: the browser only STARTS the payment. Whether the order is paid is decided by the
  // signed webhook below — never by anything the browser says.
  return startPayment({ orderId, amountPaise: order.amountPaise, outcome, webhookUrl });
}

// ---------------------------------------------------------------------------
// The webhook — the ONLY way an order becomes paid
// ---------------------------------------------------------------------------

// Returns { outcome, … }. The HTTP layer answers 200 for every outcome: "we handled it,
// stop retrying" — even when the business result is a failure. Only a crash answers 500,
// which makes the provider retry later.
export async function handlePaymentEvent(event, provider = 'fake') {
  const { orderId, paymentId, amountPaise } = event.data;

  const result = await withTransaction(async (client) => {
    // 1. IDEMPOTENCY: each delivery has a unique event id. Seen it → do nothing.
    //    (INSERT … ON CONFLICT DO NOTHING is atomic: two simultaneous deliveries can't both pass.)
    const { rowCount } = await client.query(
      `INSERT INTO processed_webhooks (webhook_id, provider) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
      [event.id, provider],
    );
    if (rowCount === 0) return { outcome: 'duplicate' };

    // 2. Lock the order: two DIFFERENT deliveries about the same order wait for each other.
    if (!(await ordersRepository.lockOrder(client, orderId))) return { outcome: 'unknown_order' };
    const order = await ordersRepository.findOrderById(client, orderId);

    // 3a. Payment failed → the order fails and its held tickets go back on sale.
    if (event.type === 'payment.failed') {
      if (order.status !== 'pending') return { outcome: 'ignored', status: order.status };
      await ordersRepository.markFailed(client, { orderId, paymentId, reason: 'payment_failed' });
      return { outcome: 'failed', releaseHoldId: order.holdId };
    }

    // 3b. Payment succeeded.
    if (order.status === 'paid') return { outcome: 'already_paid' }; // another delivery got here first
    if (order.status === 'failed') {
      console.warn(`[refund] order ${orderId} already failed, but payment ${paymentId} succeeded: refund it`);
      return { outcome: 'refund_needed' };
    }
    if (amountPaise !== order.amountPaise) {
      await ordersRepository.markFailed(client, { orderId, paymentId, reason: 'amount_mismatch' });
      console.warn(`[refund] order ${orderId}: paid ${amountPaise}, expected ${order.amountPaise}: refund it`);
      return { outcome: 'failed', releaseHoldId: order.holdId };
    }

    // 3c. Purchase cap (Phase 5b), checked against the TRUTH: paid orders in PostgreSQL.
    //     Redis already refuses a hold over the cap; this catches what Redis can't see, e.g. two
    //     orders paid for at once (an old pending order paid late + a new one), or a Redis that
    //     lost its counts. Locking the event row first makes payments for this event take turns,
    //     so two of them can't both read "0 bought" and both pass.
    await eventsRepository.lockEvent(client, order.eventId);
    const paidBefore = await ordersRepository.paidQuantityForUser(client, order.eventId, order.userId);
    const limit = await purchaseLimitFor(order.eventId, order.userId, client); // 4, or more if an admin approved
    if (paidBefore + order.quantity > limit) {
      await ordersRepository.markFailed(client, { orderId, paymentId, reason: 'purchase_limit' });
      console.warn(`[refund] order ${orderId}: over the ${limit}-ticket limit: refund payment ${paymentId}`);
      return { outcome: 'refund_needed', releaseHoldId: order.holdId };
    }

    // 4. Make sure the tickets are really set aside — in REDIS, before we commit.
    //    Normal case: the hold still exists → consume it (its tickets stay out of stock).
    //    LATE payment: the hold expired and was released → try to take the tickets again.
    //    Order matters: Redis first, then commit. If the commit then failed, tickets would be
    //    missing from stock (an UNDERSELL — safe). The other way round, a crash between commit and
    //    Redis could leave a hold whose tickets later go back on sale although they were sold.
    let reserved = order.holdId ? await consumeHold(order.holdId) : false;
    if (!reserved) {
      await ensureStock(await eventsRepository.findEventById(order.eventId));
      reserved = await takeFromStock(order.eventId, order.quantity, { pool: order.pool });
      // No hold was consumed, so count these tickets as bought here (consume-hold.lua does it otherwise).
      if (reserved) await addBought(order.eventId, order.userId, order.quantity);
    }
    if (!reserved) {
      // Late AND sold out meanwhile: we can't deliver. Fail the order; the money must go back.
      await ordersRepository.markFailed(client, { orderId, paymentId, reason: 'sold_out_after_expiry' });
      console.warn(`[refund] order ${orderId}: paid after expiry and sold out: refund payment ${paymentId}`);
      return { outcome: 'refund_needed' };
    }

    // 5. Hand out ticket numbers — atomically, and the CHECK (tickets_sold <= total_tickets)
    //    makes the database itself refuse an oversell — then record the sale.
    const ticketNumbers = await eventsRepository.takeTicketNumbers(client, order.eventId, order.quantity);
    await ordersRepository.insertSoldTickets(client, { eventId: order.eventId, orderId, ticketNumbers });
    await ordersRepository.markPaid(client, { orderId, paymentId });
    return { outcome: 'paid', ticketNumbers };
  });

  // After the commit: give a failed order's held tickets back. (If this fails, the hold simply
  // expires and is released later — tickets come back either way.)
  if (result.releaseHoldId) await releaseHold(result.releaseHoldId);
  // A receipt (Phase 7). Not awaited: the provider's webhook gets its answer at once, and a mail
  // problem can't undo a payment (sendMail queues it; the worker retries).
  if (result.outcome === 'paid') sendReceipt(orderId).catch((err) => console.warn(`[mail] receipt for order ${orderId}: ${err.message}`));
  const { releaseHoldId: _, ...answer } = result;
  return answer;
}

async function sendReceipt(orderId) {
  const order = await ordersRepository.findOrderById(pool, orderId);
  const { rows } = await pool.query('SELECT email FROM users WHERE id = $1', [order.userId]);
  if (!rows[0]) return;
  await sendMail({
    to: rows[0].email,
    subject: `Your tickets for ${order.eventName}`,
    text:
      `Thank you! Your payment of ${formatRupees(order.amountPaise)} is confirmed.\n\n` +
      `Event: ${order.eventName}\n` +
      `Tickets: ${order.quantity} — number${order.quantity > 1 ? 's' : ''} ${order.ticketNumbers.map((t) => `#${t}`).join(', ')}\n` +
      `Order: ${order.id}\n\n` +
      `You can see your tickets any time under "My orders".`,
  });
}
