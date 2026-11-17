// Access tokens: short-lived JWTs signed with HS256 (HMAC-SHA256 + our secret).
import { SignJWT, jwtVerify, errors } from 'jose';
import { env } from '../../config/env.js';
import { AppError } from '../../lib/errors.js';

const ALGORITHM = 'HS256';
const secretKey = new TextEncoder().encode(env.jwt.accessSecret); // jose wants raw bytes
const ROLES = new Set(['user', 'admin']);

// Payload is READABLE by anyone (only base64url-encoded), so it holds ids and roles, never secrets.
export function signAccessToken(user) {
  const now = Math.floor(Date.now() / 1000); // JWT times are in SECONDS since 1970
  return new SignJWT({ role: user.role })
    .setProtectedHeader({ alg: ALGORITHM, typ: 'JWT' })
    .setSubject(String(user.id)) // "sub" = who this token is about
    .setIssuer(env.jwt.issuer)
    .setAudience(env.jwt.audience)
    .setIssuedAt(now)
    .setExpirationTime(now + env.jwt.accessTtlSeconds)
    .sign(secretKey);
}

// Returns { id, role } or throws a 401 AppError. Never trust a token we didn't verify.
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
  if (!Number.isSafeInteger(id) || id < 1 || !ROLES.has(payload.role)) {
    throw new AppError(401, 'INVALID_TOKEN', 'Access token is invalid');
  }
  return { id, role: payload.role };
}
