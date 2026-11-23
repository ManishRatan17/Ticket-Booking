// Admin-only endpoints. There is deliberately NO auth code in this file:
// app.js mounts the whole router behind  authenticate + requireRole('admin'),
// so every route added here later is protected automatically ("default deny").
import { Router } from 'express';
import { validate } from '../../middleware/validate.js';
import { listUsersQuerySchema, userIdParamsSchema, changeRoleBodySchema } from './admin.schemas.js';
import * as adminController from './admin.controller.js';
import { createEventSchema } from '../events/events.schemas.js';
import * as eventsController from '../events/events.controller.js';

const router = Router();

router.get('/users', validate({ query: listUsersQuerySchema }), adminController.listUsers);
router.patch(
  '/users/:id/role',
  validate({ params: userIdParamsSchema, body: changeRoleBodySchema }),
  adminController.changeRole,
);

// Events: protected by the same router-level admin guard as everything in this file.
router.post('/events', validate({ body: createEventSchema }), eventsController.createEvent);

export default router;
