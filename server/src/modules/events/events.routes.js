// Public event pages + ticket holds. Mounted at /api in app.js.
// (Creating events is admin-only and lives in admin.routes.js, behind the admin guard.)
import { Router } from 'express';
import { validate } from '../../middleware/validate.js';
import { authenticate } from '../../middleware/authenticate.js';
import { eventIdParamsSchema, holdBodySchema, holdIdParamsSchema } from './events.schemas.js';
import * as eventsController from './events.controller.js';
import { holdPerIp, holdPerUser, releasePerUser } from '../../lib/ticketRateLimits.js';

const router = Router();

// Anyone may look.
router.get('/events', eventsController.listEvents);
router.get('/events/:id', validate({ params: eventIdParamsSchema }), eventsController.getEvent);

// Holding needs a signed-in user (the access-token cookie).
router.post(
  '/events/:id/holds',
  holdPerIp, // before authenticate: turn a flood away cheaply
  authenticate,
  holdPerUser,
  validate({ params: eventIdParamsSchema, body: holdBodySchema }),
  eventsController.holdTickets,
);
router.get('/events/:id/holds/mine', authenticate, validate({ params: eventIdParamsSchema }), eventsController.getMyHold);
router.delete('/holds/:holdId', authenticate, releasePerUser, validate({ params: holdIdParamsSchema }), eventsController.releaseMyHold);

export default router;
