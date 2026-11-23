// A FAKE payment company, running inside our server so the whole flow works without an account.
// It behaves like the real thing (Razorpay, Stripe…) in the ways that matter:
//
//   1. The customer "pays" on the provider's side; we only get a payment id back.
//   2. LATER, the provider tells our server what happened by calling our WEBHOOK URL,
//      server-to-server, with an HMAC signature.
//   3. If our webhook doesn't answer 2xx, the provider RETRIES (with growing pauses).
//
// So our server never believes the browser about money — only signed webhooks.
// In Phase 7 this file is replaced by real Razorpay; the webhook side stays the same.
import { randomBytes } from 'node:crypto';
import { env } from '../../config/env.js';
import { signPayload, SIGNATURE_HEADER } from './signature.js';

const randomId = (prefix) => `${prefix}_${randomBytes(8).toString('hex')}`;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// "The customer completed the payment form." outcome: 'success' | 'failure'.
export function startPayment({ orderId, amountPaise, outcome, webhookUrl }) {
  const paymentId = randomId('pay_fake');
  const event = {
    id: randomId('evt_fake'), // unique per DELIVERY: we use it to ignore repeats
    type: outcome === 'success' ? 'payment.succeeded' : 'payment.failed',
    data: { orderId, paymentId, amountPaise },
  };
  // The answer to the browser doesn't wait for this: a real provider calls back later.
  setTimeout(() => {
    deliver(webhookUrl, JSON.stringify(event)).catch((err) =>
      console.error(`[fake-provider] gave up on ${event.id}: ${err.message}`),
    );
  }, env.payments.fakeDelayMs);
  return { paymentId };
}

// Up to 4 attempts with EXPONENTIAL BACKOFF (wait 0.2 s, 0.4 s, 0.8 s): a struggling server
// gets breathing room instead of being hammered.
async function deliver(url, rawBody, { attempts = 4, firstDelayMs = 200 } = {}) {
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', [SIGNATURE_HEADER]: signPayload(rawBody, env.payments.webhookSecret) },
        body: rawBody,
        signal: AbortSignal.timeout(5000),
      });
      if (res.ok) return;
      if (res.status < 500) throw new Error(`webhook refused it (${res.status}); not retrying`); // our bug, not a hiccup
    } catch (err) {
      if (err.message.includes('not retrying') || attempt === attempts) throw err;
    }
    await sleep(firstDelayMs * 2 ** (attempt - 1));
  }
}
