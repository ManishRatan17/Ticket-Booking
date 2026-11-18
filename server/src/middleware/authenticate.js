// Protects a route: only requests carrying a valid access token get through.
//
//   router.get('/me', authenticate, controller.me);
//
// The token comes ONLY from the httpOnly `access_token` cookie, which the browser sends
// by itself. (An Authorization header is ignored: one way in, one CSRF story.)
// On success sets req.user = { id, role, sessionId }.
import { AppError } from '../lib/errors.js';
import { verifyAccessToken } from '../modules/auth/tokens.js';
import { isSessionRevoked } from '../modules/auth/revocation.js';
import { readAccessCookie } from '../modules/auth/auth.cookies.js';

export async function authenticate(req, res, next) {
  const token = readAccessCookie(req);
  if (!token) {
    // No cookie: never logged in, or the 15-minute cookie expired → the client should
    // try POST /api/auth/refresh once, then retry.
    throw new AppError(401, 'AUTH_REQUIRED', 'Authentication required');
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
