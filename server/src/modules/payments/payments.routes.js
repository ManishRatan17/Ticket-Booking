// Payments. Two very different callers:
//   • the BROWSER starts a (fake) payment:            POST /api/payments/fake/:orderId
//   • the PROVIDER reports the result (server-to-server): POST /api/webhooks/payments
import express, { Router } from 'express';
import { z } from 'zod';
import { env } from '../../config/env.js';
import { AppError } from '../../lib/errors.js';
import { validate } from '../../middleware/validate.js';
import { authenticate } from '../../middleware/authenticate.js';
import { isValidSignature, SIGNATURE_HEADER } from './signature.js';
import * as paymentsService from './payments.service.js';

// ---------- browser: start a fake payment ----------

export const paymentsRouter = Router();

paymentsRouter.post(
  '/payments/fake/:orderId',
  authenticate,
  validate({
    params: z.object({ orderId: z.coerce.number().int().positive() }),
    body: z.object({ outcome: z.enum(['success', 'failure']) }), // the fake form's two buttons
  }),
  async (req, res) => {
    const { paymentId } = await paymentsService.startFakePayment({
      orderId: req.validated.params.orderId,
      userId: req.user.id,
      outcome: req.validated.body.outcome,
      // The fake provider calls back the same host the browser used (through Vite in development).
      webhookUrl: `${req.protocol}://${req.get('host')}/api/webhooks/payments`,
    });
    res.status(202).json({ paymentId }); // 202 Accepted: the result arrives later, by webhook
  },
);

// ---------- provider: the webhook ----------

const webhookSchema = z.object({
  id: z.string().min(1).max(100),
  type: z.enum(['payment.succeeded', 'payment.failed']),
  data: z.object({
    orderId: z.number().int().positive(),
    paymentId: z.string().min(1).max(100),
    amountPaise: z.number().int().min(0),
  }),
});

export const webhooksRouter = Router();

// express.raw keeps the body as the EXACT bytes received. The signature is computed over those
// bytes; parsing to an object and back could change spacing or key order and break it.
// (That's why app.js mounts this router BEFORE the global express.json().)
webhooksRouter.post('/payments', express.raw({ type: 'application/json', limit: '10kb' }), async (req, res) => {
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

  const result = await paymentsService.handlePaymentEvent(event);
  res.json({ received: true, ...result });
});
