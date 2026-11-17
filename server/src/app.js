import express from 'express';
import helmet from 'helmet';
import cookieParser from 'cookie-parser';
import healthRouter from './routes/health.js';
import authRouter from './modules/auth/auth.routes.js';
import { notFound, errorHandler } from './middleware/errorHandler.js';

export function createApp() {
  const app = express();

  // Middleware runs top to bottom for every request.
  app.use(helmet()); // security-related HTTP response headers
  app.use(express.json({ limit: '10kb' })); // parse JSON bodies; refuse anything bigger than 10 KB
  app.use(cookieParser()); // read cookies into req.cookies (refresh tokens will live in a cookie)

  app.use('/api/health', healthRouter);
  app.use('/api/auth', authRouter);

  // These two must be LAST: nothing above matched → 404; anything threw → error handler.
  app.use(notFound);
  app.use(errorHandler);

  return app;
}
