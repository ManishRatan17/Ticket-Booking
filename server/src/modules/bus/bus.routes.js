// Bus booking. busRouter is mounted at /api/bus (app.js); busAdminRouter at /api/admin/bus inside
// the admin router, so it inherits the admin guard ("default deny") and the audit log.
import { Router } from 'express';
import { validate } from '../../middleware/validate.js';
import { authenticate } from '../../middleware/authenticate.js';
import { customersOnly } from '../../middleware/customersOnly.js';
import { requireNotRestricted } from '../../middleware/requireNotRestricted.js';
import { requireIdempotencyKey } from '../../middleware/idempotencyKey.js';
import { rateLimit } from '../../lib/rateLimiter.js';
import { confirmBodySchema, createTripSchema, holdBodySchema, idParamsSchema, searchQuerySchema } from './bus.schemas.js';
import * as controller from './bus.controller.js';

const MINUTE = 60;
const searchPerIp = rateLimit({ name: 'bus-search-ip', limit: 120, windowSeconds: MINUTE, key: (req) => req.ip });
const holdPerIp = rateLimit({ name: 'bus-hold-ip', limit: 120, windowSeconds: MINUTE, key: (req) => req.ip });
const holdPerUser = rateLimit({ name: 'bus-hold-user', limit: 10, windowSeconds: MINUTE, key: (req) => `user:${req.user.id}` });

export const busRouter = Router();

// Anyone can search and look at a seat map.
busRouter.get('/trips', searchPerIp, validate({ query: searchQuerySchema }), controller.searchTrips);
busRouter.get('/trips/:id', searchPerIp, validate({ params: idParamsSchema }), controller.getTrip);

// Booking needs an account; admins don't book, restricted accounts can't.
busRouter.post(
  '/trips/:id/holds',
  holdPerIp,
  authenticate,
  customersOnly,
  requireNotRestricted,
  holdPerUser,
  requireIdempotencyKey,
  validate({ params: idParamsSchema, body: holdBodySchema }),
  controller.holdSeats,
);
busRouter.post(
  '/bookings/:id/confirm',
  authenticate,
  customersOnly,
  requireNotRestricted,
  validate({ params: idParamsSchema, body: confirmBodySchema }),
  controller.confirmBooking,
);
busRouter.post('/bookings/:id/cancel', authenticate, validate({ params: idParamsSchema }), controller.cancelBooking);
busRouter.get('/bookings', authenticate, controller.listBookings);
busRouter.get('/bookings/:id', authenticate, validate({ params: idParamsSchema }), controller.getBooking);

export const busAdminRouter = Router();
busAdminRouter.get('/trips', controller.listTripsForAdmin);
busAdminRouter.post('/trips', validate({ body: createTripSchema }), controller.createTrip);
