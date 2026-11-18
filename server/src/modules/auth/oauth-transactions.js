// Remembers the secrets of a Google sign-in that is in progress (state, nonce, PKCE verifier)
// between step ① (sending the browser to Google) and the callback a minute later.
//
// Stored in Redis under a random id; the id goes in a cookie, which ties the
// sign-in to the browser that started it. Each one is single-use and expires in 10 minutes.
import { randomBytes } from 'node:crypto';
import { redis } from '../../config/redis.js';
import { hashToken } from './tokens.js';

export const OAUTH_TX_TTL_SECONDS = 10 * 60;

// The id in the cookie is a secret, so (like refresh tokens) only its hash becomes the Redis key.
const key = (txId) => `oauth:tx:${hashToken(txId)}`;

export async function saveTransaction(data) {
  const txId = randomBytes(32).toString('base64url');
  // EX = Redis deletes the key by itself after this many seconds.
  await redis.set(key(txId), JSON.stringify(data), 'EX', OAUTH_TX_TTL_SECONDS);
  return txId;
}

// GETDEL reads AND deletes in one atomic command: if the same callback arrives twice
// (a replay, a double-click), exactly one request gets the data — the other gets null.
export async function takeTransaction(txId) {
  if (!txId) return null;
  const raw = await redis.getdel(key(txId));
  return raw ? JSON.parse(raw) : null;
}
