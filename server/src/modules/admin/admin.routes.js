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

export default router;
