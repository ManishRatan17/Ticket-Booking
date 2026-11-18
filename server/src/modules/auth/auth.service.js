// Business logic for auth. Knows the RULES; knows nothing about HTTP (no req/res here).
import { randomBytes } from 'node:crypto';
import { env } from '../../config/env.js';
import { withTransaction } from '../../config/db.js';
import { AppError } from '../../lib/errors.js';
import { isUniqueViolation } from '../../lib/db-errors.js';
import { hashPassword, verifyPassword, needsRehash } from './password.js';
import { signAccessToken, generateRefreshToken, hashToken } from './tokens.js';
import * as authRepository from './auth.repository.js';
import * as sessionsRepository from './sessions.repository.js';

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

// A refresh token never outlives its session: min(now + 7 days, session end).
function refreshExpiry(sessionExpiresAt) {
  const sliding = Date.now() + env.session.refreshTtlSeconds * 1000;
  return new Date(Math.min(sliding, new Date(sessionExpiresAt).getTime()));
}

// Creates the session row and its first refresh token, together or not at all.
async function startSession(userId, { userAgent, ip }) {
  const sessionExpiresAt = new Date(Date.now() + env.session.ttlSeconds * 1000);
  const refresh = { token: generateRefreshToken(), expiresAt: refreshExpiry(sessionExpiresAt) };

  const sessionId = await withTransaction(async (client) => {
    const id = await sessionsRepository.createSession(client, {
      userId,
      userAgent: userAgent?.slice(0, 500) ?? null, // headers are client-controlled: cap the size
      ip: ip ?? null,
      expiresAt: sessionExpiresAt,
    });
    await sessionsRepository.insertRefreshToken(client, {
      sessionId: id,
      tokenHash: hashToken(refresh.token), // the RAW token is never stored
      expiresAt: refresh.expiresAt,
    });
    return id;
  });
  return { sessionId, refresh };
}

// `refresh` is returned separately so the controller can put it in a cookie, not the JSON body.
// `device` = { userAgent, ip } of the request, stored on the session for the device list.
export async function login({ email, password }, device = {}) {
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
  const { sessionId, refresh } = await startSession(user.id, device);
  return {
    accessToken: await signAccessToken(publicUser, sessionId),
    tokenType: 'Bearer',
    expiresIn: env.jwt.accessTtlSeconds,
    user: publicUser,
    refresh,
  };
}

// Rotation: trade a refresh token for a NEW refresh token + a new access token.
// Each refresh token works exactly once. Presenting a used one again = theft signal.
export async function refresh(refreshToken) {
  if (!refreshToken) {
    throw new AppError(401, 'REFRESH_TOKEN_MISSING', 'No refresh token');
  }
  const tokenHash = hashToken(refreshToken);

  // The transaction RETURNS an outcome instead of throwing, because a throw would roll back —
  // and the "revoke session after reuse" write must be KEPT even though the request fails.
  const result = await withTransaction(async (client) => {
    const claimed = await sessionsRepository.claimRefreshToken(client, tokenHash);

    if (claimed) {
      if (claimed.sessionRevoked) return { outcome: 'session_revoked' };
      if (new Date(claimed.sessionExpiresAt) <= new Date()) return { outcome: 'session_expired' };

      const next = { token: generateRefreshToken(), expiresAt: refreshExpiry(claimed.sessionExpiresAt) };
      const nextId = await sessionsRepository.insertRefreshToken(client, {
        sessionId: claimed.sessionId,
        tokenHash: hashToken(next.token),
        expiresAt: next.expiresAt,
      });
      await sessionsRepository.linkReplacement(client, claimed.tokenId, nextId);
      await sessionsRepository.touchSession(client, claimed.sessionId);
      return { outcome: 'ok', user: claimed.user, sessionId: claimed.sessionId, refresh: next };
    }

    // The claim failed. Find out why.
    const existing = await sessionsRepository.findRefreshToken(client, tokenHash);
    if (!existing) return { outcome: 'invalid' };
    if (!existing.used) return { outcome: 'expired' }; // unused but not claimable → past expires_at

    if (existing.secondsSinceUsed <= env.session.reuseGraceSeconds) {
      return { outcome: 'conflict' }; // used a moment ago: almost certainly another tab
    }

    // Used long ago and presented again: someone has a copy of this token.
    await sessionsRepository.revokeSession(client, existing.sessionId, 'token_reuse');
    return { outcome: 'reused', sessionId: existing.sessionId };
  });

  // The transaction has committed. NOW it's safe to turn outcomes into errors.
  switch (result.outcome) {
    case 'ok':
      return {
        accessToken: await signAccessToken(result.user, result.sessionId),
        tokenType: 'Bearer',
        expiresIn: env.jwt.accessTtlSeconds,
        refresh: result.refresh,
      };
    case 'conflict':
      throw new AppError(409, 'REFRESH_CONFLICT', 'Token was just refreshed by another request; retry');
    case 'reused':
      console.warn(`[security] refresh token reuse detected; session ${result.sessionId} revoked`);
      throw new AppError(401, 'REFRESH_TOKEN_REUSED', 'Session ended for security reasons; please log in again');
    case 'session_revoked':
      throw new AppError(401, 'SESSION_REVOKED', 'This session has ended; please log in again');
    case 'session_expired':
      throw new AppError(401, 'SESSION_EXPIRED', 'This session has expired; please log in again');
    case 'expired':
      throw new AppError(401, 'REFRESH_TOKEN_EXPIRED', 'Refresh token has expired; please log in again');
    default:
      throw new AppError(401, 'INVALID_REFRESH_TOKEN', 'Refresh token is invalid');
  }
}

// The token says who you were at login; the DATABASE says who you are now.
export async function getMe(userId) {
  const user = await authRepository.findUserById(userId);
  if (!user) {
    throw new AppError(401, 'INVALID_TOKEN', 'This account no longer exists');
  }
  return user;
}
