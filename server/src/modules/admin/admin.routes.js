// Admin-only endpoints. There is deliberately NO auth code in this file:
// app.js mounts the whole router behind  authenticate + requireRole('admin'),
// so every route added here later is protected automatically ("default deny").
import { Router } from 'express';
import { validate } from '../../middleware/validate.js';
import { listUsersQuerySchema, userIdParamsSchema, changeRoleBodySchema } from './admin.schemas.js';
import * as adminController from './admin.controller.js';
import { createEventSchema, updateEventSchema } from '../events/events.schemas.js';
import * as adminEvents from './admin.events.js';
import { cancelEvent } from '../events/events.cancel.js';
import { busAdminRouter } from '../bus/bus.routes.js';
import * as refunds from '../payments/refunds.js';
import * as eventsController from '../events/events.controller.js';
import { z } from 'zod';
import { AppError } from '../../lib/errors.js';
import { listAudit } from '../../lib/audit.js';
import * as adminJobs from './admin.jobs.js';
import * as support from '../support/support.service.js';
import * as moderation from '../moderation/moderation.service.js';
import { decisionSchema, listQuerySchema, messageSchema, requestIdParamsSchema } from '../support/support.schemas.js';

const router = Router();

router.get('/users', validate({ query: listUsersQuerySchema }), adminController.listUsers);
router.patch(
  '/users/:id/role',
  validate({ params: userIdParamsSchema, body: changeRoleBodySchema }),
  adminController.changeRole,
);

// Events: protected by the same router-level admin guard as everything in this file.
router.post('/events', validate({ body: createEventSchema }), async (req, res, next) => {
  // (the audit log records the NEW event's id as the target)
  const original = res.json.bind(res);
  res.json = (body) => {
    res.locals.auditTargetId = body?.event?.id;
    return original(body);
  };
  return eventsController.createEvent(req, res, next);
});
// Manage events: every event with live numbers (sold, held, left, revenue, in line…), one event, edit.
const eventIdParams = z.object({ id: z.coerce.number().int().positive() });
router.get('/events', async (req, res) => {
  res.json(await adminEvents.listEventsWithNumbers());
});
router.get('/events/:id', validate({ params: eventIdParams }), async (req, res) => {
  res.json(await adminEvents.getEventWithNumbers(req.validated.params.id));
});
router.patch('/events/:id', validate({ params: eventIdParams, body: updateEventSchema }), async (req, res) => {
  res.json(await adminEvents.updateEvent(req.validated.params.id, req.validated.body));
});
// Cancel: stop the sale, end unpaid orders, refund every paid one, email ticket holders (events.cancel.js).
router.post(
  '/events/:id/cancel',
  validate({ params: eventIdParams, body: z.object({ reason: z.string().trim().min(3).max(500) }) }),
  async (req, res) => {
    const result = await cancelEvent({ eventId: req.validated.params.id, reason: req.validated.body.reason });
    res.locals.auditDetails = result; // the audit log keeps how many orders and how much money
    res.json({ cancelled: true, ...result });
  },
);

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

// Refunds: pending ones first (with their last error), and retrying one.
router.get('/refunds', validate({ query: z.object({ status: z.enum(['pending', 'refunded']).optional() }) }), async (req, res) => {
  res.json({ refunds: await refunds.listRefunds({ status: req.validated.query.status }) });
});
router.post('/refunds/:id/retry', validate({ params: z.object({ id: z.coerce.number().int().positive() }) }), async (req, res) => {
  await refunds.retryRefund(req.validated.params.id);
  res.status(202).json({ retried: true });
});

// Notifications for admins: new automatic restrictions (bot strikes) nobody has looked at yet.
router.get('/notifications', async (req, res) => {
  res.json(await moderation.unseenRestrictions());
});
router.post('/restrictions/acknowledge', async (req, res) => {
  res.json({ acknowledged: await moderation.acknowledgeRestrictions(req.user.id) });
});

// Moderation (Phase 5e): restrictions in force (or all), restricting by hand, lifting.
router.get('/restrictions', validate({ query: z.object({ active: z.enum(['true', 'false']).default('true') }) }), async (req, res) => {
  res.json({ restrictions: await moderation.listRestrictions({ activeOnly: req.validated.query.active === 'true' }) });
});
router.post(
  '/restrictions',
  validate({
    body: z.object({
      email: z.string().trim().toLowerCase().email(),
      kind: z.enum(['suspended', 'banned']),
      days: z.number().int().min(1).max(365).default(15),
      reason: z.string().trim().min(3).max(500),
    }),
  }),
  async (req, res) => {
    const restriction = await moderation.restrictByEmail({ adminId: req.user.id, ...req.validated.body });
    if (!restriction) throw new AppError(409, 'ALREADY_RESTRICTED', 'This account is already restricted');
    res.status(201).json({ restriction });
  },
);
router.post(
  '/restrictions/:id/lift',
  validate({
    params: z.object({ id: z.coerce.number().int().positive() }),
    body: z.object({ reason: z.string().trim().min(3).max(500), overturn: z.boolean().default(false) }),
  }),
  async (req, res) => {
    res.json({ restriction: await moderation.lift({ adminId: req.user.id, restrictionId: req.validated.params.id, ...req.validated.body }) });
  },
);

// The audit log (read-only: entries can't be changed or deleted, the database refuses it).
router.get(
  '/audit',
  validate({ query: z.object({ action: z.string().max(60).optional(), limit: z.coerce.number().int().min(1).max(500).default(200) }) }),
  async (req, res) => {
    res.json({ entries: await listAudit(req.validated.query) });
  },
);

// Bus trips (modules/bus/): same admin guard and audit log as everything here.
router.use('/bus', busAdminRouter);

export default router;
