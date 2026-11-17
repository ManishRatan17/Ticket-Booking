// Business logic for auth. Knows the RULES; knows nothing about HTTP (no req/res here).
import { AppError } from '../../lib/errors.js';
import { isUniqueViolation } from '../../lib/db-errors.js';
import { hashPassword } from './password.js';
import * as authRepository from './auth.repository.js';

export async function register({ email, password }) {
  const passwordHash = await hashPassword(password);

  // No "does this email exist?" check first — that would be a check-then-act race
  // (two parallel requests could both pass the check). We just INSERT and let the
  // database's UNIQUE constraint decide atomically.
  try {
    return await authRepository.createUser({ email, passwordHash });
  } catch (err) {
    if (isUniqueViolation(err, 'users_email_key')) {
      throw new AppError(409, 'EMAIL_TAKEN', 'An account with this email already exists');
    }
    throw err; // anything else is unexpected → 500
  }
}
