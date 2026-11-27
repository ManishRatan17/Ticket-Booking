// Train booking. trainRouter is mounted at /api/train (app.js); trainAdminRouter at /api/admin/train
// inside the admin router, so it inherits the admin guard ("default deny") and the audit log.
import { Router } from 'express';
import { validate } from '../../middleware/validate.js';
import { authenticate } from '../../middleware/authenticate.js';
import { customersOnly } from '../../middleware/customersOnly.js';
import { requireNotRestricted } from '../../middleware/requireNotRestricted.js';
import { requireIdempotencyKey } from '../../middleware/idempotencyKey.js';
import { rateLimit } from '../../lib/rateLimiter.js';
import { confirmBodySchema, createTripSchema, holdBodySchema, idParamsSchema, searchQuerySchema } from './train.schemas.js';
import * as controller from './train.controller.js';
import { bookingPaymentRoutes } from '../booking-payments/booking-payments.routes.js';
import './train.payments.js'; // registers the train with booking payments

const MINUTE = 60;
const searchPerIp = rateLimit({ name: 'train-search-ip', limit: 120, windowSeconds: MINUTE, key: (req) => req.ip });
const holdPerIp = rateLimit({ name: 'train-hold-ip', limit: 120, windowSeconds: MINUTE, key: (req) => req.ip });
const holdPerUser = rateLimit({ name: 'train-hold-user', limit: 10, windowSeconds: MINUTE, key: (req) => `user:${req.user.id}` });

export const trainRouter = Router();

// Anyone can search and see a trip's classes and availability.
trainRouter.get('/trips', searchPerIp, validate({ query: searchQuerySchema }), controller.searchTrips);
trainRouter.get('/routes', searchPerIp, controller.listRoutes); // suggestions for the search form
trainRouter.get('/trips/:id', searchPerIp, validate({ params: idParamsSchema }), controller.getTrip);

// Booking needs an account; admins don't book, restricted accounts can't.
trainRouter.post(
  '/trips/:id/holds',
  holdPerIp,
  authenticate,
  customersOnly,
  requireNotRestricted,
  holdPerUser,
  requireIdempotencyKey,
  validate({ params: idParamsSchema, body: holdBodySchema }),
  controller.holdBerths,
);
trainRouter.post(
  '/bookings/:id/confirm',
  authenticate,
  customersOnly,
  requireNotRestricted,
  validate({ params: idParamsSchema, body: confirmBodySchema }),
  controller.confirmBooking,
);
trainRouter.post('/bookings/:id/cancel', authenticate, validate({ params: idParamsSchema }), controller.cancelBooking);
trainRouter.get('/bookings', authenticate, controller.listBookings);
// Paying: POST /bookings/:id/pay/fake | /pay/razorpay | /pay/razorpay/verify (modules/booking-payments)
trainRouter.use('/bookings', bookingPaymentRoutes('train'));
trainRouter.get('/bookings/:id', authenticate, validate({ params: idParamsSchema }), controller.getBooking);

export const trainAdminRouter = Router();
trainAdminRouter.get('/trips', controller.listTripsForAdmin);
trainAdminRouter.post('/trips', validate({ body: createTripSchema }), controller.createTrip);
