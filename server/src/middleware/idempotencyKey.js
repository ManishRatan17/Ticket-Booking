// POST endpoints that create things must be safe to retry. The client sends a random
// Idempotency-Key header; the same key always gets the same result. Shared by orders and bus bookings.
import { AppError } from '../lib/errors.js';

// Any client-made random string (we suggest a UUID).
export const IDEMPOTENCY_KEY = /^[A-Za-z0-9_-]{8,128}$/;

export function requireIdempotencyKey(req, res, next) {
  const key = req.get('idempotency-key');
  if (!key || !IDEMPOTENCY_KEY.test(key)) {
    throw new AppError(400, 'IDEMPOTENCY_KEY_REQUIRED', 'Send an Idempotency-Key header (8–128 letters, digits, - or _)');
  }
  req.idempotencyKey = key;
  next();
}
