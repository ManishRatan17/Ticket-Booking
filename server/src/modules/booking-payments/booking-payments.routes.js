// HTTP for booking payments.
//   bookingPaymentRoutes(kind): mounted by the bus and train routers at /bookings
//     POST /:id/pay/fake {outcome}         the built-in fake provider (development, tests)
//     POST /:id/pay/razorpay               create (once) the Razorpay order; what checkout needs
//     POST /:id/pay/razorpay/verify        Razorpay's answer from the page (signature checked)
//   bookingWebhooksRouter: POST /api/webhooks/booking-payments/:kind (the fake provider, signed)
//   (Razorpay's own webhook stays /api/webhooks/razorpay: payments.service hands bookings over here.)
import express, { Router } from 'express';
import { z } from 'zod';
import { env } from '../../config/env.js';
import { AppError } from '../../lib/errors.js';
import { validate } from '../../middleware/validate.js';
import { authenticate } from '../../middleware/authenticate.js';
import { customersOnly } from '../../middleware/customersOnly.js';
import { requireNotRestricted } from '../../middleware/requireNotRestricted.js';
import { payPerUser } from '../../lib/ticketRateLimits.js';
import { isValidSignature, SIGNATURE_HEADER } from '../payments/signature.js';
import * as bookingPayments from './booking-payments.js';

const KINDS = ['bus', 'train'];
const params = z.object({ id: z.coerce.number().int().positive() });
const guards = [authenticate, customersOnly, requireNotRestricted, payPerUser];

export function bookingPaymentRoutes(kind) {
  const router = Router();

  router.post(
    '/:id/pay/fake',
    ...guards,
    validate({ params, body: z.object({ outcome: z.enum(['success', 'failure']) }) }),
    async (req, res) => {
      const { paymentId } = await bookingPayments.startFakePayment(kind, {
        bookingId: req.validated.params.id,
        userId: req.user.id,
        outcome: req.validated.body.outcome,
        webhookUrl: `${req.protocol}://${req.get('host')}/api/webhooks/booking-payments/${kind}`,
      });
      res.status(202).json({ paymentId }); // 202: the result arrives later, by webhook
    },
  );

  router.post('/:id/pay/razorpay', ...guards, validate({ params }), async (req, res) => {
    res.json(await bookingPayments.startRazorpayPayment(kind, { bookingId: req.validated.params.id, userId: req.user.id }));
  });

  router.post(
    '/:id/pay/razorpay/verify',
    ...guards,
    validate({
      params,
      body: z.object({
        razorpay_order_id: z.string().min(1).max(100),
        razorpay_payment_id: z.string().min(1).max(100),
        razorpay_signature: z.string().min(1).max(200),
      }),
    }),
    async (req, res) => {
      const b = req.validated.body;
      const result = await bookingPayments.confirmRazorpayPayment(kind, {
        bookingId: req.validated.params.id,
        userId: req.user.id,
        razorpayOrderId: b.razorpay_order_id,
        razorpayPaymentId: b.razorpay_payment_id,
        razorpaySignature: b.razorpay_signature,
      });
      res.json({ outcome: result.outcome });
    },
  );
  return router;
}

const webhookSchema = z.object({
  id: z.string().min(1).max(100),
  type: z.enum(['payment.succeeded', 'payment.failed']),
  data: z.object({ orderId: z.number().int().positive(), paymentId: z.string().min(1).max(100), amountPaise: z.number().int().min(0) }),
});

// Raw body: the signature covers the exact bytes (mounted before express.json(), like the events' webhook).
export const bookingWebhooksRouter = Router();
bookingWebhooksRouter.post('/booking-payments/:kind', express.raw({ type: 'application/json', limit: '10kb' }), async (req, res) => {
  const { kind } = req.params;
  if (!KINDS.includes(kind)) throw new AppError(404, 'NOT_FOUND', 'Unknown booking kind');
  const rawBody = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
  if (!isValidSignature(rawBody, req.get(SIGNATURE_HEADER), env.payments.webhookSecret)) {
    throw new AppError(401, 'INVALID_SIGNATURE', 'Webhook signature is missing or wrong');
  }
  let event;
  try {
    event = webhookSchema.parse(JSON.parse(rawBody.toString('utf8')));
  } catch {
    throw new AppError(400, 'INVALID_WEBHOOK', 'Webhook body is not a valid payment event');
  }
  const result = await bookingPayments.processPayment(kind, {
    eventId: event.id,
    bookingId: event.data.orderId,
    paymentId: event.data.paymentId,
    amountPaise: event.data.amountPaise,
    provider: 'fake',
    failed: event.type === 'payment.failed',
  });
  res.json(result); // 200 for every handled outcome: "stop retrying"
});
