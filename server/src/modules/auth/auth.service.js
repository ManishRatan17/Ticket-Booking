// Business logic for auth. Knows the RULES; knows nothing about HTTP (no req/res here).
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { env } from '../../config/env.js';
import { pool, withTransaction } from '../../config/db.js';
import { AppError } from '../../lib/errors.js';
import { isUniqueViolation } from '../../lib/db-errors.js';
import { hashPassword, verifyPassword, needsRehash } from './password.js';
import { signAccessToken, generateRefreshToken, hashToken } from './tokens.js';
import * as authRepository from './auth.repository.js';
import * as sessionsRepository from './sessions.repository.js';
import * as identitiesRepository from './identities.repository.js';
import * as revocation from './revocation.js';
import { isGoogleConfigured, exchangeCode, verifyIdToken } from './google.js';
import { takeTransaction } from './oauth-transactions.js';

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
    await revocation.revokeSession(client, existing.sessionId, 'token_reuse');
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

// ---------------------------------------------------------------------------
// Continue with Google
// ---------------------------------------------------------------------------

function sameString(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && timingSafeEqual(x, y);
}

// Turns a verified Google profile into one of OUR users. Four cases:
//   1. this Google account is already linked         → that user
//   2. new Google account, email unknown              → create a user (no password)
//   3. email belongs to an account with VERIFIED email → link to it
//   4. email belongs to an UNVERIFIED password account → "verified email wins":
//      link it, remove the password, end all its sessions (it may be a squatter's)
async function findOrCreateGoogleUser({ sub, email }) {
  return withTransaction(async (client) => {
    const linked = await identitiesRepository.findUserByIdentity(client, 'google', sub);
    if (linked) {
      await identitiesRepository.touchIdentity(client, 'google', sub);
      return linked; // case 1
    }

    const existing = await identitiesRepository.findUserByEmailForUpdate(client, email);
    let user;
    if (!existing) {
      user = await identitiesRepository.createVerifiedUser(client, email); // case 2
    } else if (existing.emailVerifiedAt) {
      user = existing; // case 3
    } else {
      await identitiesRepository.removePasswordAndMarkVerified(client, existing.id); // case 4
      await revocation.revokeAllUserSessions(client, existing.id, 'account_linked');
      user = existing;
    }

    await identitiesRepository.insertIdentity(client, {
      userId: user.id,
      provider: 'google',
      providerUserId: sub,
      email,
    });
    await identitiesRepository.markEmailVerified(client, user.id);
    const { emailVerifiedAt: _, ...publicUser } = user;
    return publicUser;
  });
}

// The callback: Google sent the browser back with ?code=...&state=...
// `txId` comes from the oauth_tx cookie set when this browser started the sign-in.
export async function loginWithGoogle({ code, state, txId }, device = {}) {
  if (!isGoogleConfigured()) {
    throw new AppError(503, 'GOOGLE_NOT_CONFIGURED', 'Google sign-in is not configured');
  }

  // Single use: GETDEL means a replayed callback finds nothing.
  // Missing cookie = this browser never started a sign-in (e.g. a link from an attacker).
  const tx = await takeTransaction(txId);
  if (!tx) {
    throw new AppError(400, 'OAUTH_TX_INVALID', 'Sign-in expired or was already used; please start again');
  }
  // The state Google echoed back must be the one THIS browser was given.
  if (!state || !sameString(state, tx.state)) {
    throw new AppError(400, 'OAUTH_STATE_MISMATCH', 'Sign-in could not be verified; please start again');
  }
  if (!code) {
    throw new AppError(400, 'OAUTH_CODE_MISSING', 'Google did not return a code');
  }

  const idToken = await exchangeCode({ code, codeVerifier: tx.codeVerifier });
  const profile = await verifyIdToken(idToken, tx.nonce);

  // If two sign-ins for the same new email race, one INSERT hits a UNIQUE constraint.
  // Running the whole decision again then finds the row the other request created.
  let user;
  for (let attempt = 1; ; attempt++) {
    try {
      user = await findOrCreateGoogleUser(profile);
      break;
    } catch (err) {
      // Our user already has a DIFFERENT Google account linked (same email, different "sub").
      if (isUniqueViolation(err, 'user_identities_user_id_provider_key')) {
        throw new AppError(409, 'GOOGLE_ACCOUNT_CONFLICT', 'This email is linked to a different Google account');
      }
      const raced =
        isUniqueViolation(err, 'users_email_key') ||
        isUniqueViolation(err, 'user_identities_provider_provider_user_id_key');
      if (!raced || attempt === 2) throw err;
    }
  }

  // From here on it's an ordinary session — the same refresh rotation as a password login.
  const { refresh } = await startSession(user.id, device);
  return { user, refresh };
}

// ---------------------------------------------------------------------------
// Logout and session management
// ---------------------------------------------------------------------------

// Identified by the refresh cookie, so it works even when the access token has expired.
// Never fails: no cookie, an unknown token or an already-ended session all just mean
// "you're logged out" — and that is already true.
export async function logout(refreshToken) {
  if (!refreshToken) return;
  await withTransaction(async (client) => {
    const sessionId = await sessionsRepository.findSessionIdByRefreshToken(client, hashToken(refreshToken));
    if (sessionId) await revocation.revokeSession(client, sessionId, 'logout');
  });
}

export async function logoutAll(userId) {
  return withTransaction((client) => revocation.revokeAllUserSessions(client, userId, 'logout_all'));
}

export async function listSessions({ id: userId, sessionId: currentSessionId }) {
  const sessions = await sessionsRepository.listActiveSessions(pool, userId);
  return sessions.map((s) => ({ ...s, current: s.id === currentSessionId }));
}

// 404 — not 403 — when the session isn't yours: a 403 would confirm that it exists.
export async function revokeOwnSession(userId, sessionId) {
  const revoked = await withTransaction((client) =>
    revocation.revokeOwnSession(client, { sessionId, userId }, 'logout'),
  );
  if (!revoked) throw new AppError(404, 'SESSION_NOT_FOUND', 'No active session with this id');
}

// The token says who you were at login; the DATABASE says who you are now.
export async function getMe(userId) {
  const user = await authRepository.findUserById(userId);
  if (!user) {
    throw new AppError(401, 'INVALID_TOKEN', 'This account no longer exists');
  }
  return user;
}
