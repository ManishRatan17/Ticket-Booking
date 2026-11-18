// Authorization: "you are logged in — but are you ALLOWED to do this?"
// Always used AFTER authenticate, which sets req.user = { id, role, sessionId }.
//
//   app.use('/api/admin', authenticate, requireRole('admin'), adminRouter);
//
//   401 = we don't know who you are (authenticate failed)
//   403 = we know exactly who you are, and the answer is no
import { AppError } from '../lib/errors.js';

export function requireRole(...roles) {
  const allowed = new Set(roles);
  return (req, res, next) => {
    if (!req.user) {
      // Only possible if a route forgot `authenticate` before this — fail safe, not open.
      throw new AppError(401, 'AUTH_REQUIRED', 'Authentication required');
    }
    if (!allowed.has(req.user.role)) {
      throw new AppError(403, 'FORBIDDEN', 'You do not have permission to do this');
    }
    next();
  };
}
