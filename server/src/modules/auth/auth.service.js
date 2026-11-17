// Business logic for auth. Knows the RULES; knows nothing about HTTP (no req/res here).
import { randomBytes } from 'node:crypto';
import { env } from '../../config/env.js';
import { AppError } from '../../lib/errors.js';
import { isUniqueViolation } from '../../lib/db-errors.js';
import { hashPassword, verifyPassword, needsRehash } from './password.js';
import { signAccessToken } from './tokens.js';
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

// A hash of a random password nobody knows, created once on first use.
// Logins for unknown emails are verified against it so they take as long as real ones.
let dummyHashPromise;
function getDummyHash() {
  dummyHashPromise ??= hashPassword(randomBytes(32).toString('hex'));
  return dummyHashPromise;
}

export async function login({ email, password }) {
  const user = await authRepository.findUserForLogin(email);

  // ALWAYS run a full argon2 verify — against the real hash, or the dummy one —
  // so "no such user" and "wrong password" take the same time.
  const passwordOk = await verifyPassword(user?.passwordHash ?? (await getDummyHash()), password);

  if (!user || !passwordOk) {
    // One message for both cases: never reveal which emails have accounts.
    throw new AppError(401, 'INVALID_CREDENTIALS', 'Email or password is incorrect');
  }

  // Login is the only moment we have the plain password, so it's the only chance
  // to upgrade a hash made with older, weaker settings.
  if (needsRehash(user.passwordHash)) {
    await authRepository.updatePasswordHash(user.id, await hashPassword(password));
  }

  const { passwordHash: _, ...publicUser } = user; // drop the hash before it goes anywhere
  return {
    accessToken: await signAccessToken(publicUser),
    tokenType: 'Bearer',
    expiresIn: env.jwt.accessTtlSeconds,
    user: publicUser,
  };
}

// The token says who you were at login; the DATABASE says who you are now.
export async function getMe(userId) {
  const user = await authRepository.findUserById(userId);
  if (!user) {
    throw new AppError(401, 'INVALID_TOKEN', 'This account no longer exists');
  }
  return user;
}
