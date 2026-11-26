// CANCELLING AN EVENT (admin). Nothing is deleted: the event and its orders are the record of who
// paid what. What happens:
//
//   ONE transaction ── lock the event's open orders (pending + paid) ── mark the event cancelled
//                   ── paid orders → 'cancelled' + a refund row each (reason event_cancelled)
//                   ── pending orders → 'cancelled' (nothing was paid)
//   after commit   ── forget the cached event · close the waiting room · give held tickets back
//                   ── process the refunds (jobs, retried) · email everyone who had paid
//
// Why the refunds are recorded IN the transaction: if the event is cancelled, every refund owed is on
// record too, or neither happened. Nobody can be forgotten, whatever crashes afterwards.
//
// LOCK ORDER: orders first, the event row last, the same order the payment transaction uses (order,
// then event). Taking them the other way round, a payment and a cancel could each wait for the other
// (a deadlock: measured, see cancel-event.test.js). A payment that arrives after the cancel sees the
// cancelled event under that lock and is refunded instead (payments.service.js).
import { pool, withTransaction } from '../../config/db.js';
import { AppError } from '../../lib/errors.js';
import { sendMail } from '../../lib/mailer.js';
import { formatRupees } from '../../lib/money.js';
import { recordRefund, requestRefund } from '../payments/refunds.js';
import { releaseHold } from '../reservation/holds.js';
import { dropRoom } from '../waiting-room/waiting-room.js';
import { forgetEvent } from './events.service.js';

// Which provider took the money: an order paid through Razorpay has a Razorpay order id.
const providerOf = (order) => (order.provider_order_id ? 'razorpay' : 'fake');

export async function cancelEvent({ eventId, reason }) {
  const result = await withTransaction(async (client) => {
    // 1. The open orders, locked (a payment for one of them right now finishes first, then we see it).
    const { rows: orders } = await client.query(
      `SELECT id, user_id, status, quantity, amount_paise, payment_id, provider_order_id, hold_id
         FROM orders WHERE event_id = $1 AND status IN ('pending', 'paid') ORDER BY id FOR UPDATE`,
      [eventId],
    );

    // 2. The event (its row lock is taken here, last).
    const { rows: cancelled } = await client.query(
      `UPDATE events SET cancelled_at = now(), cancel_reason = $2
        WHERE id = $1 AND cancelled_at IS NULL RETURNING name`,
      [eventId, reason],
    );
    if (cancelled.length === 0) {
      const { rows } = await client.query('SELECT cancelled_at FROM events WHERE id = $1', [eventId]);
      if (rows.length === 0) throw new AppError(404, 'EVENT_NOT_FOUND', 'No event with this id');
      throw new AppError(409, 'ALREADY_CANCELLED', 'This event is already cancelled', { cancelledAt: rows[0].cancelled_at });
    }

    // 3. Every open order is cancelled; every PAID one gets its money back.
    await client.query(
      `UPDATE orders SET status = 'cancelled', failure_reason = 'event_cancelled', updated_at = now() WHERE id = ANY($1::bigint[])`,
      [orders.map((o) => o.id)],
    );
    const paid = orders.filter((o) => o.status === 'paid');
    const refundIds = [];
    for (const o of paid) {
      const id = await recordRefund(client, {
        orderId: o.id,
        userId: o.user_id,
        provider: providerOf(o),
        paymentId: o.payment_id,
        amountPaise: o.amount_paise,
        reason: 'event_cancelled',
      });
      if (id) refundIds.push(id);
    }
    return {
      name: cancelled[0].name,
      paid,
      refundIds,
      pendingHoldIds: orders.filter((o) => o.status === 'pending' && o.hold_id).map((o) => o.hold_id),
    };
  });

  // After the commit. Each step can fail without undoing the cancellation: holds expire by
  // themselves, a refund that wasn't queued stays 'pending' (Refunds page: Retry).
  forgetEvent(eventId); // this server's 1-second copy; other servers see it within a second
  await dropRoom(eventId).catch((err) => console.warn(`[cancel] event ${eventId}: waiting room not dropped: ${err.message}`));
  for (const holdId of result.pendingHoldIds) await releaseHold(holdId).catch(() => {});
  for (const id of result.refundIds) {
    await requestRefund(id).catch((err) => console.warn(`[cancel] refund #${id} not queued: ${err.message}`));
  }
  emailTicketHolders(result.name, reason, result.paid).catch((err) => console.warn(`[mail] cancellation of event ${eventId}: ${err.message}`));

  console.log(`[cancel] event ${eventId} cancelled: ${result.paid.length} paid orders refunded, ${result.pendingHoldIds.length} unpaid orders ended`);
  return {
    ordersCancelled: result.paid.length + result.pendingHoldIds.length,
    paidOrdersRefunded: result.refundIds.length,
    refundTotalPaise: result.paid.reduce((sum, o) => sum + o.amount_paise, 0),
  };
}

// One email per paid order. (The refund's own email follows once the money is on its way back.)
async function emailTicketHolders(eventName, reason, paidOrders) {
  if (paidOrders.length === 0) return;
  const { rows } = await pool.query('SELECT id, email FROM users WHERE id = ANY($1::bigint[])', [paidOrders.map((o) => o.user_id)]);
  const emailOf = new Map(rows.map((r) => [String(r.id), r.email]));
  for (const o of paidOrders) {
    const to = emailOf.get(String(o.user_id));
    if (!to) continue;
    await sendMail({
      to,
      subject: `Cancelled: ${eventName}`,
      text:
        `We're sorry: ${eventName} has been cancelled.\n\nReason: ${reason}\n\n` +
        `Your ${o.quantity} ticket${o.quantity > 1 ? 's are' : ' is'} no longer valid (order ${o.id}). ` +
        (o.amount_paise > 0
          ? `You don't need to do anything: the ${formatRupees(o.amount_paise)} you paid is being refunded automatically, and we'll email you once it's on its way.`
          : 'You paid nothing, so there is nothing to refund.'),
    });
  }
}
