import express from 'express';
import helmet from 'helmet';
import cookieParser from 'cookie-parser';
import healthRouter from './routes/health.js';
import authRouter from './modules/auth/auth.routes.js';
import adminRouter from './modules/admin/admin.routes.js';
import eventsRouter from './modules/events/events.routes.js';
import { authenticate } from './middleware/authenticate.js';
import { requireRole } from './middleware/authorize.js';
import { rejectCrossSiteRequests } from './middleware/csrf.js';
import { env } from './config/env.js';
import { notFound, errorHandler } from './middleware/errorHandler.js';

export function createApp() {
  const app = express();

  // Decides what req.ip is when we run behind a proxy (see TRUST_PROXY in env.js).
  app.set('trust proxy', env.trustProxy);

  // Middleware runs top to bottom for every request.
  app.use(helmet()); // security-related HTTP response headers
  app.use(express.json({ limit: '10kb' })); // parse JSON bodies; refuse anything bigger than 10 KB
  app.use(cookieParser()); // read cookies into req.cookies (both tokens live in cookies)
  app.use(rejectCrossSiteRequests); // CSRF guard: cookies are sent automatically, so check who's asking

  app.use('/api/health', healthRouter);
  app.use('/api/auth', authRouter);
  // The guard is applied ONCE, to the whole admin router: no admin route can forget it.
  app.use('/api/admin', authenticate, requireRole('admin'), adminRouter);
  app.use('/api', eventsRouter); // /api/events…, /api/holds/…

  // These two must be LAST: nothing above matched → 404; anything threw → error handler.
  app.use(notFound);
  app.use(errorHandler);

  return app;
}
