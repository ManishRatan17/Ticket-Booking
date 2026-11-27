// PAYING FOR BUS AND TRAIN BOOKINGS (migration 018). One payment flow for both, so the rules are
// written (and tested) once; each module plugs in with a small adapter (its table names, and what to
// do once paid: the train gives a PNR). This file never imports bus or train: they register here.
//
//   hold (10 min) ──► passenger details ──► PAY (fake provider, or Razorpay test mode)
//     ──► the provider's signed webhook (or Razorpay's verified answer) ──► 'confirmed' + receipt
//
// The payment transaction (processPayment), like the event orders' (payments.service.js):
//   • idempotent: each delivery's id goes into processed_webhooks; a repeat changes nothing
//   • lock order: the TRIP row, then the booking (the same order as holds and cancels: no deadlocks)
//   • money taken but nothing delivered → a refund, recorded IN this transaction, never twice
//   • a payment arriving after the hold ran out: confirmed if its seats are still free, refunded if not
import { pool, withTransaction } from '../../config/db.js';
import { env } from '../../config/env.js';
import { AppError } from '../../lib/errors.js';
import { sendMail } from '../../lib/mailer.js';
import { startPayment } from '../payments/fake-provider.js';
import * as razorpay from '../payments/razorpay.js';
import { recordRefund, requestRefund } from '../payments/refunds.js';

// kind ('bus' | 'train') → { bookings, seats, seatColumn, trips, onPaid?(client, id), receipt?(client, id) }
const targets = new Map();
export function registerPaymentTarget(kind, adapter) {
  targets.set(kind, { kind, ...adapter });
}
function target(kind) {
  const t = targets.get(kind);
  if (!t) throw new Error(`No payment target "${kind}"`);
  return t;
}

const BOOKING_COLUMNS = 'id, trip_id, user_id, status, amount_paise, held_until, passengers_at, payment_provider, provider_order_id, payment_id';
const code = (kind, suffix) => `${kind.toUpperCase()}_${suffix}`;

async function findOwnBooking(client, t, bookingId, userId) {
  const { rows } = await client.query(`SELECT ${BOOKING_COLUMNS} FROM ${t.bookings} WHERE id = $1 AND user_id = $2`, [bookingId, userId]);
  if (!rows[0]) throw new AppError(404, code(t.kind, 'BOOKING_NOT_FOUND'), 'No booking with this id');
  return rows[0];
}

// Can this booking be paid now? (The webhook re-checks everything under the locks.)
function checkPayable(t, b) {
  if (b.status === 'confirmed') throw new AppError(409, 'BOOKING_ALREADY_PAID', 'This booking is already confirmed');
  if (b.status !== 'held') throw new AppError(409, 'BOOKING_NOT_PAYABLE', `This booking is ${b.status}`, { status: b.status });
  if (!(b.amount_paise > 0)) throw new AppError(409, 'NOTHING_TO_PAY', 'This booking is free: confirm it with the passenger details');
  if (!b.passengers_at) throw new AppError(409, 'PASSENGERS_REQUIRED', 'Give the passenger details first, then pay');
  if (new Date(b.held_until) <= new Date()) {
    throw new AppError(409, code(t.kind, 'HOLD_EXPIRED'), 'The 10 minutes your seats were held are up; please book again');
  }
}

// ---------- starting a payment (the browser) ----------

export async function startFakePayment(kind, { bookingId, userId, outcome, webhookUrl }) {
  if (env.payments.razorpay.enabled) throw new AppError(404, 'FAKE_PAYMENTS_OFF', 'Payments go through Razorpay');
  const t = target(kind);
  const b = await findOwnBooking(pool, t, bookingId, userId);
  checkPayable(t, b);
  // The fake provider calls our webhook later, signed; only that confirms the booking.
  return startPayment({ orderId: Number(b.id), amountPaise: b.amount_paise, outcome, webhookUrl });
}

export async function startRazorpayPayment(kind, { bookingId, userId }) {
  if (!env.payments.razorpay.enabled) throw new AppError(404, 'RAZORPAY_OFF', 'Razorpay is not configured on this server');
  const t = target(kind);
  const b = await findOwnBooking(pool, t, bookingId, userId);
  checkPayable(t, b);
  let razorpayOrderId = b.provider_order_id;
  if (!razorpayOrderId) {
    const created = await razorpay.createOrder({
      amountPaise: b.amount_paise,
      receipt: `${kind}_${b.id}`,
      notes: { kind, bookingId: String(b.id) },
    });
    // Kept only if the booking has none yet (two clicks at once: the first one wins).
    const { rows } = await pool.query(
      `UPDATE ${t.bookings} SET provider_order_id = $2, updated_at = now() WHERE id = $1 AND provider_order_id IS NULL RETURNING provider_order_id`,
      [b.id, created.id],
    );
    razorpayOrderId = rows[0]?.provider_order_id ?? (await findOwnBooking(pool, t, bookingId, userId)).provider_order_id;
  }
  return {
    keyId: env.payments.razorpay.keyId,
    razorpayOrderId,
    amountPaise: b.amount_paise,
    currency: 'INR',
    description: `${kind === 'bus' ? 'Bus' : 'Train'} booking ${b.id}`,
  };
}

// Razorpay's answer reported by the page: a valid signature proves Razorpay says it's paid.
export async function confirmRazorpayPayment(kind, { bookingId, userId, razorpayOrderId, razorpayPaymentId, razorpaySignature }) {
  const t = target(kind);
  const b = await findOwnBooking(pool, t, bookingId, userId);
  if (!b.provider_order_id || b.provider_order_id !== razorpayOrderId || !razorpay.isValidPaymentSignature({ razorpayOrderId, razorpayPaymentId, razorpaySignature })) {
    throw new AppError(400, 'PAYMENT_SIGNATURE_INVALID', 'This payment confirmation could not be verified');
  }
  return processPayment(kind, {
    eventId: `rzp_pay_${razorpayPaymentId}`,
    bookingId: Number(b.id),
    paymentId: razorpayPaymentId,
    amountPaise: b.amount_paise,
    provider: 'razorpay',
  });
}

// Razorpay's webhook for an order that isn't an event order: is it one of our bookings?
// Returns the result, or null (not a booking either).
export async function handleRazorpayBookingPayment({ providerOrderId, paymentId, amountPaise, eventId }) {
  for (const t of targets.values()) {
    const { rows } = await pool.query(`SELECT id FROM ${t.bookings} WHERE provider_order_id = $1`, [providerOrderId]);
    if (rows[0]) return processPayment(t.kind, { eventId, bookingId: Number(rows[0].id), paymentId, amountPaise, provider: 'razorpay' });
  }
  return null;
}

// ---------- the payment transaction ----------

// Returns { outcome }: paid | duplicate | already_paid | attempt_failed | amount_mismatch | refund_needed | unknown_booking
export async function processPayment(kind, { eventId, bookingId, paymentId, amountPaise, provider, failed = false }) {
  const t = target(kind);
  const result = await withTransaction(async (client) => {
    // 1. A delivery we've seen? Do nothing. (Atomic: two simultaneous deliveries can't both pass.)
    const { rowCount } = await client.query(
      'INSERT INTO processed_webhooks (webhook_id, provider) VALUES ($1, $2) ON CONFLICT DO NOTHING',
      [eventId, provider],
    );
    if (rowCount === 0) return { outcome: 'duplicate' };

    // 2. The trip, then the booking: locked, in that order.
    const { rows: found } = await client.query(`SELECT trip_id FROM ${t.bookings} WHERE id = $1`, [bookingId]);
    if (!found[0]) return { outcome: 'unknown_booking' };
    await client.query(`SELECT id FROM ${t.trips} WHERE id = $1 FOR UPDATE`, [found[0].trip_id]);
    const { rows } = await client.query(`SELECT ${BOOKING_COLUMNS} FROM ${t.bookings} WHERE id = $1 FOR UPDATE`, [bookingId]);
    const b = rows[0];

    // A failed attempt: the person may try again while the hold lasts. Nothing changes.
    if (failed) return { outcome: 'attempt_failed' };

    // Money taken, nothing delivered → a refund, recorded here (UNIQUE per payment: never twice).
    const refund = async (reason, amount = amountPaise) =>
      recordRefund(client, { bookingKind: kind, bookingId, userId: Number(b.user_id), provider, paymentId, amountPaise: amount, reason });

    if (b.status === 'confirmed') {
      if (b.payment_id === paymentId) return { outcome: 'already_paid' };
      return { outcome: 'refund_needed', refundId: await refund('booking_not_payable') }; // paid twice
    }
    if (b.status === 'cancelled') return { outcome: 'refund_needed', refundId: await refund('booking_not_payable') };
    if (amountPaise !== b.amount_paise) {
      return { outcome: 'amount_mismatch', refundId: await refund('amount_mismatch') }; // what was PAID goes back
    }

    // 3. Paid after the hold ran out (it may even be marked expired): still deliverable if no one
    //    else holds its seats now; otherwise the money goes back.
    if (b.status !== 'held' || new Date(b.held_until) <= new Date()) {
      await client.query(
        `WITH gone AS (
           UPDATE ${t.bookings} SET status = 'expired', updated_at = now()
            WHERE trip_id = $1 AND status = 'held' AND held_until <= now() AND id <> $2 RETURNING id)
         UPDATE ${t.seats} SET active = false WHERE booking_id IN (SELECT id FROM gone)`,
        [b.trip_id, bookingId],
      ); // other holds that ran out give their seats back first
      const { rows: clash } = await client.query(
        `SELECT 1 FROM ${t.seats} AS mine JOIN ${t.seats} AS other
             ON other.trip_id = mine.trip_id AND other.${t.seatColumn} = mine.${t.seatColumn}
            AND other.active AND other.booking_id <> mine.booking_id
          WHERE mine.booking_id = $1 LIMIT 1`,
        [bookingId],
      );
      if (clash.length) {
        await client.query(`UPDATE ${t.bookings} SET status = 'expired', updated_at = now() WHERE id = $1`, [bookingId]);
        await client.query(`UPDATE ${t.seats} SET active = false WHERE booking_id = $1`, [bookingId]);
        return { outcome: 'refund_needed', refundId: await refund('seats_unavailable') };
      }
      await client.query(`UPDATE ${t.seats} SET active = true WHERE booking_id = $1`, [bookingId]);
    }

    // 4. Confirmed.
    await client.query(
      `UPDATE ${t.bookings} SET status = 'confirmed', payment_id = $2, payment_provider = $3, paid_at = now(),
              confirmed_at = now(), updated_at = now() WHERE id = $1`,
      [bookingId, paymentId, provider],
    );
    await t.onPaid?.(client, bookingId);
    return { outcome: 'paid' };
  });

  if (result.refundId) await requestRefund(result.refundId);
  if (result.outcome === 'paid' && t.receipt) {
    // Not awaited: the provider gets its answer at once; a mail problem can't undo a payment.
    t.receipt(pool, bookingId)
      .then((mail) => mail && sendMail(mail))
      .catch((err) => console.warn(`[mail] ${kind} receipt for booking ${bookingId}: ${err.message}`));
  }
  const { refundId: _, ...answer } = result;
  return answer;
}

// ---------- cancelling a paid booking ----------

// Called by a module's cancel, INSIDE its transaction (trip + booking already locked): a confirmed,
// paid booking gets its money back. Returns the refund id (process it after the commit), or null.
export async function refundOnCancel(client, kind, booking) {
  if (booking.status !== 'confirmed' || !booking.paymentId || !(booking.amountPaise > 0)) return null;
  return recordRefund(client, {
    bookingKind: kind,
    bookingId: booking.id,
    userId: booking.userId,
    provider: booking.paymentProvider,
    paymentId: booking.paymentId,
    amountPaise: booking.amountPaise,
    reason: 'booking_cancelled',
  });
}
export { requestRefund };
