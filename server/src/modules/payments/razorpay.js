// Razorpay (https://razorpay.com/docs), test mode: the real payment provider (Phase 7).
// Plain HTTPS + HMAC: no SDK needed.
//
//   1. createOrder   our server → Razorpay: "an order of ₹998.00" (Basic auth: key id + key SECRET)
//   2. the page opens Razorpay's own checkout window (their script, their iframe): card details
//      never touch our server
//   3. paid → the page gets razorpay_payment_id, razorpay_order_id, razorpay_signature, where
//         signature = HMAC-SHA256(key = KEY SECRET, "<order_id>|<payment_id>")
//      only Razorpay and we know the secret, so a valid signature PROVES Razorpay says it's paid
//   4. Razorpay ALSO calls our webhook, signed with the WEBHOOK SECRET over the exact raw body
//      (X-Razorpay-Signature): the backup when the tab was closed before step 3 reached us
import { createHmac, timingSafeEqual } from 'node:crypto';
import { env } from '../../config/env.js';
import { AppError } from '../../lib/errors.js';

const hmacHex = (key, data) => createHmac('sha256', key).update(data).digest('hex');

// Constant-time comparison (like signature.js): never leak how many characters matched.
function sameHex(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

const authHeaders = () => ({
  Authorization: `Basic ${Buffer.from(`${env.payments.razorpay.keyId}:${env.payments.razorpay.keySecret}`).toString('base64')}`,
  'Content-Type': 'application/json',
});

export async function createOrder({ amountPaise, receipt, notes }) {
  const { apiUrl } = env.payments.razorpay;
  let res;
  try {
    res = await fetch(`${apiUrl}/orders`, {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ amount: amountPaise, currency: 'INR', receipt, notes }),
      signal: AbortSignal.timeout(10_000),
    });
  } catch (err) {
    throw new AppError(503, 'PAYMENTS_UNAVAILABLE', 'Could not reach the payment provider. Please try again.', { cause: err.message });
  }
  if (!res.ok) {
    console.error(`[razorpay] creating an order failed: ${res.status} ${(await res.text()).slice(0, 200)}`);
    throw new AppError(503, 'PAYMENTS_UNAVAILABLE', 'The payment provider refused to start the payment. Please try again.');
  }
  return res.json(); // { id: "order_…", amount, currency, receipt, status: "created", … }
}

// Refund a payment (fully). SAFE TO RETRY: first ask Razorpay for this payment's refunds and look for
// ours (we tag it with our refund id). A retry after a timeout — when the first call may have
// worked — then finds it instead of refunding twice. Returns Razorpay's refund id ("rfnd_…").
// Throws on failure (the job is retried).
export async function refundPayment({ paymentId, amountPaise, refundId }) {
  const { apiUrl } = env.payments.razorpay;
  const listed = await fetch(`${apiUrl}/payments/${encodeURIComponent(paymentId)}/refunds`, { headers: authHeaders(), signal: AbortSignal.timeout(10_000) });
  if (listed.ok) {
    const existing = ((await listed.json()).items ?? []).find((r) => r.notes?.refundId === String(refundId));
    if (existing) return existing.id;
  }
  const res = await fetch(`${apiUrl}/payments/${encodeURIComponent(paymentId)}/refund`, {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify({ amount: amountPaise, receipt: `refund_${refundId}`, notes: { refundId: String(refundId) } }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`Razorpay refused the refund: ${res.status} ${(await res.text()).slice(0, 200)}`);
  return (await res.json()).id;
}

export const isValidPaymentSignature = ({ razorpayOrderId, razorpayPaymentId, razorpaySignature }) =>
  sameHex(hmacHex(env.payments.razorpay.keySecret, `${razorpayOrderId}|${razorpayPaymentId}`), razorpaySignature);

export const isValidWebhookSignature = (rawBody, signature) =>
  Boolean(env.payments.razorpay.webhookSecret) && sameHex(hmacHex(env.payments.razorpay.webhookSecret, rawBody), signature);
