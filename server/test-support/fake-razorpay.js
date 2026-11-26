// A tiny FAKE Razorpay for tests (like fake-google.js and fake-turnstile.js). It does what Razorpay
// does in our flow, with the same shapes and the same signatures:
//   POST /v1/orders            create an order (checks Basic auth: key id + key secret)
//   pay(orderId)               what the checkout window hands the page after a successful payment:
//                              { razorpay_payment_id, razorpay_order_id, razorpay_signature }
//   webhook(kind, orderId, …)  a signed webhook delivery: { body, headers }
import express from 'express';
import { once } from 'node:events';
import { createHmac, randomBytes } from 'node:crypto';

const rid = (prefix) => `${prefix}_${randomBytes(7).toString('hex')}`;
const hmac = (key, data) => createHmac('sha256', key).update(data).digest('hex');

export async function startFakeRazorpay({ keyId, keySecret, webhookSecret }) {
  const orders = new Map(); // id → order
  const calls = [];

  const app = express();
  app.use(express.json());
  app.post('/v1/orders', (req, res) => {
    const expected = `Basic ${Buffer.from(`${keyId}:${keySecret}`).toString('base64')}`;
    calls.push({ auth: req.get('authorization') === expected, body: req.body });
    if (req.get('authorization') !== expected) return res.status(401).json({ error: { code: 'BAD_REQUEST_ERROR', description: 'Authentication failed' } });
    const order = { id: rid('order'), entity: 'order', amount: req.body.amount, currency: req.body.currency, receipt: req.body.receipt, notes: req.body.notes, status: 'created' };
    orders.set(order.id, order);
    res.json(order);
  });

  // Refunds. refundMode: 'ok' | 'fail' (500) | 'timeout_after_refund' (refunds, then answers 504 as if
  // the answer got lost: the case where a retry must NOT refund again).
  const refunds = []; // { id, payment_id, amount, notes }
  let refundMode = 'ok';
  app.get('/v1/payments/:id/refunds', (req, res) => {
    res.json({ entity: 'collection', items: refunds.filter((r) => r.payment_id === req.params.id) });
  });
  app.post('/v1/payments/:id/refund', (req, res) => {
    if (refundMode === 'fail') return res.status(500).json({ error: { code: 'SERVER_ERROR', description: 'try later' } });
    const refund = { id: rid('rfnd'), entity: 'refund', payment_id: req.params.id, amount: req.body.amount, notes: req.body.notes, status: 'processed' };
    refunds.push(refund);
    if (refundMode === 'timeout_after_refund') return res.status(504).json({ error: { code: 'GATEWAY_TIMEOUT' } });
    res.json(refund);
  });

  const server = app.listen(0);
  await once(server, 'listening');

  return {
    apiUrl: `http://localhost:${server.address().port}/v1`,
    calls,
    orders,
    refunds,
    setRefundMode: (mode) => (refundMode = mode),
    // The checkout window's answer for a successful payment.
    pay(orderId, { secret = keySecret } = {}) {
      const paymentId = rid('pay');
      return { razorpay_payment_id: paymentId, razorpay_order_id: orderId, razorpay_signature: hmac(secret, `${orderId}|${paymentId}`) };
    },
    // A webhook delivery as Razorpay sends it.
    webhook(event, orderId, { paymentId = rid('pay'), amount = orders.get(orderId)?.amount, eventId = rid('evt'), secret = webhookSecret } = {}) {
      const body = JSON.stringify({
        entity: 'event',
        event,
        payload: { payment: { entity: { id: paymentId, entity: 'payment', order_id: orderId, amount, currency: 'INR', status: event === 'payment.captured' ? 'captured' : 'failed' } } },
      });
      return { body, headers: { 'Content-Type': 'application/json', 'X-Razorpay-Signature': hmac(secret, body), 'X-Razorpay-Event-Id': eventId }, paymentId };
    },
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}
