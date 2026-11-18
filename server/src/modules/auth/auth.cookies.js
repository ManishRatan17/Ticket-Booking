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
