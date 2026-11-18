// Protects a route: only requests with a valid access token get through.
//
//   router.get('/me', authenticate, controller.me);
//
// Expects the header   Authorization: Bearer <access token>
// On success sets req.user = { id, role, sessionId }.
import { AppError } from '../lib/errors.js';
import { verifyAccessToken } from '../modules/auth/tokens.js';

export async function authenticate(req, res, next) {
  const header = req.get('authorization');
  if (!header) {
    throw new AppError(401, 'AUTH_REQUIRED', 'Authentication required');
  }

  const [scheme, token, ...rest] = header.split(' ');
  if (scheme.toLowerCase() !== 'bearer' || !token || rest.length > 0) {
    throw new AppError(401, 'INVALID_TOKEN', 'Authorization header must be: Bearer <token>');
  }

  // Express 5 sends errors thrown in async middleware to the error handler for us.
  req.user = await verifyAccessToken(token);
  next();
}
