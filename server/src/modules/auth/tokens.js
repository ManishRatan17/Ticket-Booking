// Access tokens: short-lived JWTs signed with HS256 (HMAC-SHA256 + our secret).
// Refresh tokens: long random strings; only their SHA-256 hash is stored.
import { randomBytes, createHash } from 'node:crypto';
import { SignJWT, jwtVerify, errors } from 'jose';
import { env } from '../../config/env.js';
import { AppError } from '../../lib/errors.js';

const ALGORITHM = 'HS256';
const secretKey = new TextEncoder().encode(env.jwt.accessSecret); // jose wants raw bytes
const ROLES = new Set(['user', 'admin']);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Payload is READABLE by anyone (only base64url-encoded), so it holds ids and roles, never secrets.
export function signAccessToken(user, sessionId) {
  const now = Math.floor(Date.now() / 1000); // JWT times are in SECONDS since 1970
  return new SignJWT({ role: user.role, sid: sessionId }) // sid = which login session issued it
    .setProtectedHeader({ alg: ALGORITHM, typ: 'JWT' })
    .setSubject(String(user.id)) // "sub" = who this token is about
    .setIssuer(env.jwt.issuer)
    .setAudience(env.jwt.audience)
    .setIssuedAt(now)
    .setExpirationTime(now + env.jwt.accessTtlSeconds)
    .sign(secretKey);
}

// Returns { id, role, sessionId } or throws a 401 AppError. Never trust a token we didn't verify.
export async function verifyAccessToken(token) {
  let payload;
  try {
    ({ payload } = await jwtVerify(token, secretKey, {
      algorithms: [ALGORITHM], // ONLY HS256: rejects "alg":"none" and algorithm-swap tricks
      issuer: env.jwt.issuer,
      audience: env.jwt.audience,
    }));
  } catch (err) {
    if (err instanceof errors.JWTExpired) {
      throw new AppError(401, 'TOKEN_EXPIRED', 'Access token has expired');
    }
    throw new AppError(401, 'INVALID_TOKEN', 'Access token is invalid');
  }

  // Signature is valid, but still check the payload has the shape we expect.
  const id = Number(payload.sub);
  if (
    !Number.isSafeInteger(id) ||
    id < 1 ||
    !ROLES.has(payload.role) ||
    typeof payload.sid !== 'string' ||
    !UUID.test(payload.sid)
  ) {
    throw new AppError(401, 'INVALID_TOKEN', 'Access token is invalid');
  }
  return { id, role: payload.role, sessionId: payload.sid };
}

// 32 random bytes = 256 bits: impossible to guess. base64url makes it safe in cookies and URLs.
// Used for refresh tokens AND password-reset tokens.
export function generateSecureToken() {
  return randomBytes(32).toString('base64url');
}

export const generateRefreshToken = generateSecureToken;

// SHA-256 (fast) is right here — NOT argon2 — because the input is random, not a human password:
// there is nothing to brute-force. And the same input always gives the same hash,
// so we can find a token with  WHERE token_hash = $1.
export function hashToken(token) {
  return createHash('sha256').update(token).digest('hex');
}
