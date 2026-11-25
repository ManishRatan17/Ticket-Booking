// Orders. Mounted at /api in app.js. Everything here needs a signed-in user.
import { Router } from 'express';
import { validate } from '../../middleware/validate.js';
import { authenticate } from '../../middleware/authenticate.js';
import { requireNotRestricted } from '../../middleware/requireNotRestricted.js';
import { createOrderSchema, orderIdParamsSchema } from './orders.schemas.js';
import * as ordersController from './orders.controller.js';
import { orderPerUser } from '../../lib/ticketRateLimits.js';

const router = Router();

router.post(
  '/orders',
  authenticate,
  requireNotRestricted,
  orderPerUser,
  ordersController.requireIdempotencyKey,
  validate({ body: createOrderSchema }),
  ordersController.createOrder,
);
router.get('/orders', authenticate, ordersController.listOrders);
router.get('/orders/:id', authenticate, validate({ params: orderIdParamsSchema }), ordersController.getOrder);

export default router;
