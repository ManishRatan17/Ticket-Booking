// REFUNDS: money that was taken but bought no tickets goes back to the person.
//
//   the payment transaction decides "this payment must be refunded" ──► recordRefund() inserts a row
//     in `refunds` INSIDE that same transaction (UNIQUE per payment: never two refunds for one payment)
//   after the commit ──► requestRefund(): a "process-refund" job (the worker; retried if it fails)
//   processRefund() ──► Razorpay: first ASK whether this refund already happened (a retry after a
//     timeout must not refund twice), then refund ──► 'refunded' + an email to the person
//
// While a refund fails, it stays 'pending' with its last error: admins see it on the Refunds page
// (and in the dead-letter queue on the System page) and can retry it.
import { randomBytes } from 'node:crypto';
import { pool, withTransaction } from '../../config/db.js';
import { env } from '../../config/env.js';
import { AppError } from '../../lib/errors.js';
import { sendMail } from '../../lib/mailer.js';
import { formatRupees } from '../../lib/money.js';
import * as razorpay from './razorpay.js';

export const REASON_TEXT = {
  sold_out_after_expiry: 'your payment arrived after your hold had expired, and the tickets had sold out by then',
  purchase_limit: 'it would have taken you over the per-person ticket limit',
  amount_mismatch: 'the amount paid did not match the order',
  order_already_failed: 'the order had already failed when the payment arrived',
  event_cancelled: 'the event was cancelled',
};

// Called INSIDE the payment transaction. Returns the refund's id, or null if this payment already
// has one (a repeated delivery).
export async function recordRefund(client, { orderId, userId, provider, paymentId, amountPaise, reason }) {
  if (!(amountPaise > 0) || !paymentId) return null; // a free order: nothing was paid, nothing to give back
  const { rows } = await client.query(
    `INSERT INTO refunds (order_id, user_id, provider, payment_id, amount_paise, reason)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (payment_id) DO NOTHING
     RETURNING id`,
    [orderId, userId, provider, paymentId, amountPaise, reason],
  );
  console.warn(`[refund] order ${orderId}: ${reason}, payment ${paymentId}: refund ${rows.length ? `#${rows[0].id} recorded` : 'already recorded'}`);
  return rows[0] ? Number(rows[0].id) : null;
}

// After the commit: process it in the background (the worker), or right away when jobs are off.
export async function requestRefund(refundId) {
  if (env.jobs.enabled) {
    const { getQueue } = await import('../../jobs/queue.js');
    // jobId: asking twice while one is waiting doesn't queue two.
    await getQueue().add('process-refund', { refundId }, { jobId: `refund-${refundId}-${Date.now()}` });
    return;
  }
  processRefund({ refundId }).catch((err) => console.warn(`[refund] #${refundId} failed: ${err.message}`));
}

// The job. Locked: two runs at the same moment (a retry and an admin's click) can't both refund.
export async function processRefund({ refundId }) {
  let done;
  try {
    done = await withTransaction(async (client) => {
      const { rows } = await client.query('SELECT * FROM refunds WHERE id = $1 FOR UPDATE', [refundId]);
      const refund = rows[0];
      if (!refund) return { status: 'not_found' };
      if (refund.status === 'refunded') return { status: 'already_refunded' };

      const providerRefundId =
        refund.provider === 'razorpay'
          ? await razorpay.refundPayment({ paymentId: refund.payment_id, amountPaise: refund.amount_paise, refundId: Number(refund.id) })
          : `rfnd_fake_${randomBytes(6).toString('hex')}`; // the fake provider "refunds" at once
      await client.query(
        `UPDATE refunds SET status = 'refunded', provider_refund_id = $2, refunded_at = now(), error = NULL,
                attempts = attempts + 1, updated_at = now() WHERE id = $1`,
        [refundId, providerRefundId],
      );
      return { status: 'refunded', refund };
    });
  } catch (err) {
    // Keep the reason on record (the row is still 'pending'), then fail the job: BullMQ retries.
    await pool
      .query('UPDATE refunds SET error = $2, attempts = attempts + 1, updated_at = now() WHERE id = $1', [refundId, err.message.slice(0, 500)])
      .catch(() => {});
    throw err;
  }

  if (done.status === 'refunded') {
    console.log(`[refund] #${refundId} refunded`);
    emailRefund(done.refund).catch((err) => console.warn(`[mail] refund #${refundId}: ${err.message}`));
  }
  return { status: done.status };
}

async function emailRefund(refund) {
  const { rows } = await pool.query(
    `SELECT u.email, e.name AS event_name FROM orders AS o JOIN events AS e ON e.id = o.event_id
       LEFT JOIN users AS u ON u.id = o.user_id WHERE o.id = $1`,
    [refund.order_id],
  );
  if (!rows[0]?.email) return;
  await sendMail({
    to: rows[0].email,
    subject: `Refund: ${formatRupees(refund.amount_paise)} for ${rows[0].event_name}`,
    text:
      `We've refunded ${formatRupees(refund.amount_paise)} for your order ${refund.order_id} (${rows[0].event_name}), ` +
      `because ${REASON_TEXT[refund.reason]}.\n\n` +
      `It goes back to the card or account you paid with; banks usually show it within 5–7 working days.`,
  });
}

// ---------- admins ----------

export async function listRefunds({ status }) {
  const { rows } = await pool.query(
    `SELECT r.id, r.order_id, r.provider, r.payment_id, r.amount_paise, r.reason, r.status, r.provider_refund_id,
            r.error, r.attempts, r.created_at, r.refunded_at, u.email AS user_email, e.name AS event_name
       FROM refunds AS r JOIN orders AS o ON o.id = r.order_id JOIN events AS e ON e.id = o.event_id
       LEFT JOIN users AS u ON u.id = r.user_id
      WHERE ($1::text IS NULL OR r.status = $1::text)
      ORDER BY (r.status = 'pending') DESC, r.created_at DESC LIMIT 200`,
    [status ?? null],
  );
  return rows.map((r) => ({
    id: Number(r.id),
    orderId: Number(r.order_id),
    provider: r.provider,
    paymentId: r.payment_id,
    amountPaise: r.amount_paise,
    reason: r.reason,
    status: r.status,
    providerRefundId: r.provider_refund_id,
    error: r.error,
    attempts: r.attempts,
    createdAt: r.created_at,
    refundedAt: r.refunded_at,
    userEmail: r.user_email,
    eventName: r.event_name,
  }));
}

export async function retryRefund(refundId) {
  const { rows } = await pool.query('SELECT status FROM refunds WHERE id = $1', [refundId]);
  if (!rows[0]) throw new AppError(404, 'REFUND_NOT_FOUND', 'No refund with this id');
  if (rows[0].status === 'refunded') throw new AppError(409, 'ALREADY_REFUNDED', 'This refund is already done');
  await requestRefund(refundId);
}
