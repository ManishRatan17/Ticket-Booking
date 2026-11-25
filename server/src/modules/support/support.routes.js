// Support inbox for signed-in people. Mounted at /api. (Admin routes: admin.routes.js.)
import { Router } from 'express';
import { validate } from '../../middleware/validate.js';
import { authenticate } from '../../middleware/authenticate.js';
import { rateLimit } from '../../lib/rateLimiter.js';
import { createRequestSchema, messageSchema, requestIdParamsSchema } from './support.schemas.js';
import * as support from './support.service.js';

const byUser = (req) => `user:${req.user.id}`;
// Writing to people costs admins time: a person can open a few requests an hour and write a
// reasonable number of messages, but can't flood the inbox.
const createPerUser = rateLimit({ name: 'support-create-user', limit: 5, windowSeconds: 3600, key: byUser });
const messagePerUser = rateLimit({ name: 'support-message-user', limit: 30, windowSeconds: 3600, key: byUser });

const router = Router();

router.post('/support/requests', authenticate, createPerUser, validate({ body: createRequestSchema }), async (req, res) => {
  res.status(201).json({ request: await support.createRequest({ userId: req.user.id, ...req.validated.body }) });
});

router.get('/support/requests', authenticate, async (req, res) => {
  res.json({ requests: await support.listMyRequests(req.user.id) });
});

router.get('/support/requests/:id', authenticate, validate({ params: requestIdParamsSchema }), async (req, res) => {
  res.json({ request: await support.getMyRequest(req.user.id, req.validated.params.id) });
});

router.post(
  '/support/requests/:id/messages',
  authenticate,
  messagePerUser,
  validate({ params: requestIdParamsSchema, body: messageSchema }),
  async (req, res) => {
    res.status(201).json({ request: await support.addMyMessage(req.user.id, req.validated.params.id, req.validated.body.body) });
  },
);

export default router;
