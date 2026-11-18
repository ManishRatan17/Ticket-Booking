// BOTH tokens travel only in cookies — never in a JSON body, never in localStorage,
// never readable by JavaScript. The browser stores and sends them by itself.
//
//   access_token   15 min    Path=/api        sent with every API call
//   refresh_token  ≤ 7 days  Path=/api/auth   sent only to the auth endpoints
//
// Because the browser attaches them AUTOMATICALLY, other websites could try to make your
// browser send requests carrying them (CSRF). SameSite=Strict is the first defence;
// middleware/csrf.js is the second.
import { env } from '../../config/env.js';

const ACCESS_COOKIE = 'access_token';
const REFRESH_COOKIE = 'refresh_token';

function baseOptions(path) {
  return {
    httpOnly: true, // JavaScript can't read it → an XSS attack can't steal it
    secure: env.cookies.secure, // HTTPS only
    sameSite: 'strict', // never sent on requests started by other websites
    path,
  };
}

// ---- access token ----
export function setAccessCookie(res, token) {
  // Same lifetime as the JWT inside it: when the cookie disappears, the token was dead anyway.
  res.cookie(ACCESS_COOKIE, token, { ...baseOptions('/api'), maxAge: env.jwt.accessTtlSeconds * 1000 });
}

export function clearAccessCookie(res) {
  res.clearCookie(ACCESS_COOKIE, baseOptions('/api')); // same path/flags, or the browser keeps it
}

export function readAccessCookie(req) {
  return req.cookies?.[ACCESS_COOKIE];
}

// ---- refresh token ----
export function setRefreshCookie(res, { token, expiresAt }) {
  res.cookie(REFRESH_COOKIE, token, { ...baseOptions('/api/auth'), expires: expiresAt });
}

export function clearRefreshCookie(res) {
  res.clearCookie(REFRESH_COOKIE, baseOptions('/api/auth'));
}

export function readRefreshCookie(req) {
  return req.cookies?.[REFRESH_COOKIE];
}

// Logging out removes both.
export function clearAuthCookies(res) {
  clearAccessCookie(res);
  clearRefreshCookie(res);
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
    secure: env.cookies.secure,
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
