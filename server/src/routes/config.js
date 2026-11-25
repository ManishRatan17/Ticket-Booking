// Public settings the browser needs. Nothing secret in here, ever.
//   GET /api/config → { "botCheck": { "siteKey": "…" | null } }
// The site key comes from the SERVER's .env, so client and server can never disagree on
// whether the bot check is on (one place to configure it).
import { Router } from 'express';
import { env } from '../config/env.js';

const router = Router();

router.get('/', (req, res) => {
  res.json({
    botCheck: { siteKey: env.botCheck.enabled ? env.botCheck.siteKey : null },
    // Which checkout the page shows: Razorpay's window (with the PUBLIC key id), or the fake provider.
    payments: env.payments.razorpay.enabled ? { provider: 'razorpay', keyId: env.payments.razorpay.keyId } : { provider: 'fake' },
  });
});

export default router;
