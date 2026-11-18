// "Continue with Google" — OpenID Connect, Authorization Code flow with PKCE.
// Every step is written out by hand so you can see it; jose does the cryptography.
//
//   ① createAuthRequest()  → URL to send the browser to Google, plus the secrets to remember
//   ② exchangeCode()       → server-to-server: trade the one-time code for an ID token
//   ③ verifyIdToken()      → check EVERYTHING about that token before believing it
import { randomBytes, createHash } from 'node:crypto';
import { createRemoteJWKSet, jwtVerify } from 'jose';
import { env } from '../../config/env.js';
import { AppError } from '../../lib/errors.js';

export function isGoogleConfigured() {
  return Boolean(env.google.clientId && env.google.clientSecret);
}

const randomString = () => randomBytes(32).toString('base64url');

// ① Build the "go to Google" URL.
export function createAuthRequest() {
  const state = randomString(); // ties Google's answer to THIS browser's login attempt (anti-CSRF)
  const nonce = randomString(); // Google copies it into the ID token (anti-replay)
  const codeVerifier = randomString(); // PKCE secret: stays on our server
  // PKCE: Google only sees the HASH now; we prove we know the original at step ②.
  const codeChallenge = createHash('sha256').update(codeVerifier).digest('base64url');

  const url = new URL(env.google.authUrl);
  url.search = new URLSearchParams({
    client_id: env.google.clientId,
    redirect_uri: env.google.redirectUri, // must EXACTLY match one registered at Google
    response_type: 'code', // "give me a one-time code", not tokens in the URL
    scope: 'openid email profile', // OpenID Connect: who the user is — nothing else
    state,
    nonce,
    code_challenge: codeChallenge,
    code_challenge_method: 'S256',
    prompt: 'select_account', // let people pick which Google account to use
  }).toString();

  return { url: url.toString(), state, nonce, codeVerifier };
}

// ② The back channel: our server talks to Google directly. The browser never sees this.
export async function exchangeCode({ code, codeVerifier }) {
  let res;
  try {
    res = await fetch(env.google.tokenUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: env.google.redirectUri,
        client_id: env.google.clientId,
        client_secret: env.google.clientSecret, // proves this request comes from OUR server
        code_verifier: codeVerifier, // proves we started this login (PKCE)
      }),
      signal: AbortSignal.timeout(5000), // never let a slow Google hang our request forever
    });
  } catch {
    throw new AppError(502, 'GOOGLE_UNAVAILABLE', 'Could not reach Google; please try again');
  }

  const body = await res.json().catch(() => ({}));
  if (!res.ok || typeof body.id_token !== 'string') {
    // e.g. invalid_grant: code expired, already used, or the PKCE verifier didn't match
    throw new AppError(401, 'GOOGLE_EXCHANGE_FAILED', 'Google sign-in failed; please try again');
  }
  return body.id_token;
}

// Google's PUBLIC keys. jose downloads them on first use, caches them,
// and re-downloads when Google rotates to a key it hasn't seen.
let googleKeys;
function getGoogleKeys() {
  googleKeys ??= createRemoteJWKSet(new URL(env.google.jwksUrl));
  return googleKeys;
}

// ③ Never believe an ID token until ALL of these pass.
export async function verifyIdToken(idToken, expectedNonce) {
  const invalid = () => new AppError(401, 'GOOGLE_TOKEN_INVALID', 'Google sign-in failed; please try again');

  let payload;
  try {
    ({ payload } = await jwtVerify(idToken, getGoogleKeys(), {
      algorithms: ['RS256'], // Google signs with its PRIVATE key; we verify with its PUBLIC key
      issuer: env.google.issuers, // made by Google…
      audience: env.google.clientId, // …for US, not for some other app
    })); // jwtVerify also checks exp (not expired)
  } catch {
    throw invalid();
  }

  if (payload.nonce !== expectedNonce) throw invalid(); // belongs to THIS login attempt
  if (typeof payload.sub !== 'string' || typeof payload.email !== 'string') throw invalid();

  if (payload.email_verified !== true) {
    throw new AppError(403, 'GOOGLE_EMAIL_UNVERIFIED', 'Your Google account email is not verified');
  }

  return {
    sub: payload.sub, // Google's permanent id for this account — what we identify users by
    email: payload.email.toLowerCase(),
  };
}
