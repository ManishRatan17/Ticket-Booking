// Admin-only endpoints. There is deliberately NO auth code in this file:
// app.js mounts the whole router behind  authenticate + requireRole('admin'),
// so every route added here later is protected automatically ("default deny").
import { Router } from 'express';
import { validate } from '../../middleware/validate.js';
import { listUsersQuerySchema, userIdParamsSchema, changeRoleBodySchema } from './admin.schemas.js';
import * as adminController from './admin.controller.js';
import { createEventSchema } from '../events/events.schemas.js';
import * as eventsController from '../events/events.controller.js';
import { z } from 'zod';
import * as adminJobs from './admin.jobs.js';
import * as support from '../support/support.service.js';
import { decisionSchema, listQuerySchema, messageSchema, requestIdParamsSchema } from '../support/support.schemas.js';

const router = Router();

router.get('/users', validate({ query: listUsersQuerySchema }), adminController.listUsers);
router.patch(
  '/users/:id/role',
  validate({ params: userIdParamsSchema, body: changeRoleBodySchema }),
  adminController.changeRole,
);

// Events: protected by the same router-level admin guard as everything in this file.
router.post('/events', validate({ body: createEventSchema }), eventsController.createEvent);

// Background jobs (Phase 3): overview + retrying a failed job from the dead-letter queue.
router.get('/jobs', async (req, res) => {
  res.json(await adminJobs.getJobsOverview());
});
router.post(
  '/jobs/:id/retry',
  validate({ params: z.object({ id: z.string().min(1).max(200) }) }),
  async (req, res) => {
    await adminJobs.retryFailedJob(req.validated.params.id);
    res.status(202).json({ retried: true }); // 202: the job will run again shortly
  },
);

// Support inbox: the requests people sent, answering, and deciding (approve / decline / close).
router.get('/support', validate({ query: listQuerySchema }), async (req, res) => {
  res.json({ requests: await support.listRequests({ status: req.validated.query.status }) });
});
router.get('/support/:id', validate({ params: requestIdParamsSchema }), async (req, res) => {
  res.json({ request: await support.getRequest(req.validated.params.id) });
});
router.post('/support/:id/messages', validate({ params: requestIdParamsSchema, body: messageSchema }), async (req, res) => {
  res.status(201).json({ request: await support.addAdminMessage(req.user.id, req.validated.params.id, req.validated.body.body) });
});
router.post('/support/:id/decision', validate({ params: requestIdParamsSchema, body: decisionSchema }), async (req, res) => {
  res.json({ request: await support.decide(req.user.id, req.validated.params.id, req.validated.body) });
});

export default router;
