// The refresh token travels ONLY in this cookie — never in a JSON body, never in localStorage.
import { env } from '../../config/env.js';

const COOKIE_NAME = 'refresh_token';

function cookieOptions() {
  return {
    httpOnly: true, // JavaScript can't read it → an XSS attack can't steal it
    secure: env.isProduction, // HTTPS only in production (local dev runs on plain http)
    sameSite: 'strict', // never sent on requests started by other websites → blocks CSRF
    path: '/api/auth', // only sent to auth endpoints, not to every API call
  };
}

export function setRefreshCookie(res, { token, expiresAt }) {
  res.cookie(COOKIE_NAME, token, { ...cookieOptions(), expires: expiresAt });
}

// Must use the same path/flags as when it was set, or the browser won't remove it.
export function clearRefreshCookie(res) {
  res.clearCookie(COOKIE_NAME, cookieOptions());
}

export function readRefreshCookie(req) {
  return req.cookies?.[COOKIE_NAME];
}

// ---- Google sign-in in progress ----
// SameSite=LAX, not Strict: the callback is a navigation coming FROM accounts.google.com.
// A Strict cookie is not sent on navigations started by another site, so every sign-in
// would fail. Lax allows exactly this case (top-level GET navigation) and still blocks
// cross-site POSTs, images, iframes and fetches.
const OAUTH_COOKIE_NAME = 'oauth_tx';

function oauthCookieOptions() {
  return {
    httpOnly: true,
    secure: env.isProduction,
    sameSite: 'lax',
    path: '/api/auth/google', // covers /api/auth/google and /api/auth/google/callback only
  };
}

export function setOAuthCookie(res, txId, maxAgeSeconds) {
  res.cookie(OAUTH_COOKIE_NAME, txId, { ...oauthCookieOptions(), maxAge: maxAgeSeconds * 1000 });
}

export function clearOAuthCookie(res) {
  res.clearCookie(OAUTH_COOKIE_NAME, oauthCookieOptions());
}

export function readOAuthCookie(req) {
  return req.cookies?.[OAUTH_COOKIE_NAME];
}
