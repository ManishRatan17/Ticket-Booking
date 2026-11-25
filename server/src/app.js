import express from 'express';
import helmet from 'helmet';
import { existsSync } from 'node:fs';
import path from 'node:path';
import cookieParser from 'cookie-parser';
import healthRouter from './routes/health.js';
import configRouter from './routes/config.js';
import authRouter from './modules/auth/auth.routes.js';
import adminRouter from './modules/admin/admin.routes.js';
import eventsRouter from './modules/events/events.routes.js';
import ordersRouter from './modules/orders/orders.routes.js';
import { paymentsRouter, webhooksRouter } from './modules/payments/payments.routes.js';
import waitingRoomRouter from './modules/waiting-room/waiting-room.routes.js';
import supportRouter from './modules/support/support.routes.js';
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
  // Security headers. The Content-Security-Policy (which scripts and frames a page may load) is
  // helmet's strict default, plus Cloudflare's "are you a person?" widget: its script, and the frame
  // it draws in. (Matters once the API serves the website itself, in production.)
  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          scriptSrc: ["'self'", 'https://challenges.cloudflare.com'],
          frameSrc: ["'self'", 'https://challenges.cloudflare.com'],
        },
      },
    }),
  );

  // Payment webhooks BEFORE express.json(): their signature covers the exact raw bytes,
  // so the body must reach the handler unparsed. (Server-to-server: no cookies involved.)
  app.use('/api/webhooks', webhooksRouter);

  app.use(express.json({ limit: '10kb' })); // parse JSON bodies; refuse anything bigger than 10 KB
  app.use(cookieParser()); // read cookies into req.cookies (both tokens live in cookies)
  app.use(rejectCrossSiteRequests); // CSRF guard: cookies are sent automatically, so check who's asking

  app.use('/api/health', healthRouter);
  app.use('/api/config', configRouter); // public settings for the page (bot-check site key)
  app.use('/api/auth', authRouter);
  // The guard is applied ONCE, to the whole admin router: no admin route can forget it.
  app.use('/api/admin', authenticate, requireRole('admin'), adminRouter);
  app.use('/api', eventsRouter); // /api/events…, /api/holds/…
  app.use('/api', ordersRouter); // /api/orders…
  app.use('/api', paymentsRouter); // /api/payments/fake/…
  app.use('/api', waitingRoomRouter); // /api/events/:id/queue
  app.use('/api', supportRouter); // /api/support/requests…

  // The website (production): the built React app, from the same server and address as the API.
  // Any other GET that isn't /api is a page of the app (React Router decides which): send index.html.
  if (env.clientDist) {
    const index = path.join(env.clientDist, 'index.html');
    if (!existsSync(index)) console.warn(`[app] CLIENT_DIST is set but ${index} doesn't exist: no website served`);
    // Built files have a fingerprint in their name (index-3fa9c1.js): they never change, cache for a year.
    app.use('/assets', express.static(path.join(env.clientDist, 'assets'), { immutable: true, maxAge: '1y' }));
    app.use(express.static(env.clientDist, { index: false }));
    app.get(/^\/(?!api(\/|$)).*/, (req, res) => res.sendFile(index));
  }

  // These two must be LAST: nothing above matched → 404; anything threw → error handler.
  app.use(notFound);
  app.use(errorHandler);

  return app;
}
