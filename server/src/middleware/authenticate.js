// Protects a route: only requests with a valid access token get through.
//
//   router.get('/me', authenticate, controller.me);
//
// Expects the header   Authorization: Bearer <access token>
// On success sets req.user = { id, role, sessionId }.
import { AppError } from '../lib/errors.js';
import { verifyAccessToken } from '../modules/auth/tokens.js';
import { isSessionRevoked } from '../modules/auth/revocation.js';

export async function authenticate(req, res, next) {
  const header = req.get('authorization');
  if (!header) {
    throw new AppError(401, 'AUTH_REQUIRED', 'Authentication required');
  }

  const [scheme, token, ...rest] = header.split(' ');
  if (scheme.toLowerCase() !== 'bearer' || !token || rest.length > 0) {
    throw new AppError(401, 'INVALID_TOKEN', 'Authorization header must be: Bearer <token>');
  }

  // 1. Math: signature, algorithm, issuer, audience, expiry. (Express 5 forwards any throw.)
  const user = await verifyAccessToken(token);

  // 2. One Redis lookup: was this token's session ended (logout, theft, …) before it expired?
  //    Without this, a JWT keeps working for up to 15 minutes after logout.
  if (await isSessionRevoked(user.sessionId)) {
    throw new AppError(401, 'SESSION_REVOKED', 'This session has ended; please log in again');
  }

  req.user = user;
  next();
}
