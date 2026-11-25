// HTTP layer: read validated input from the request, call the service, send the response.
import { env } from '../../config/env.js';
import { AppError } from '../../lib/errors.js';
import * as authService from './auth.service.js';
import { restrictionFor } from '../moderation/moderation.service.js';
import { isGoogleConfigured, createAuthRequest } from './google.js';
import { saveTransaction, takeTransaction, OAUTH_TX_TTL_SECONDS } from './oauth-transactions.js';
import {
  setAccessCookie,
  setRefreshCookie,
  clearAuthCookies,
  readRefreshCookie,
  setOAuthCookie,
  clearOAuthCookie,
  readOAuthCookie,
} from './auth.cookies.js';

// Both tokens → httpOnly cookies. Nothing token-shaped is ever put in a response body.
function setAuthCookies(res, { accessToken, refresh }) {
  setAccessCookie(res, accessToken);
  setRefreshCookie(res, refresh);
}

export async function register(req, res) {
  const user = await authService.register(req.validated.body);
  res.status(201).json({ user }); // 201 Created
}

export async function login(req, res) {
  const { user, expiresIn, ...tokens } = await authService.login(req.validated.body, {
    userAgent: req.get('user-agent'),
    ip: req.ip,
  });
  setAuthCookies(res, tokens);
  res.json({ user: { ...user, restriction: await restrictionFor(user.id) }, expiresIn }); // 200 OK
}

export async function refresh(req, res) {
  try {
    const { expiresIn, ...tokens } = await authService.refresh(readRefreshCookie(req));
    setAuthCookies(res, tokens);
    res.json({ expiresIn });
  } catch (err) {
    // A dead session's cookies should be removed from the browser. But NOT on a 409 conflict:
    // the other tab's response has just stored the NEW tokens in these same cookies,
    // and clearing them would log the user out.
    if (err.code !== 'REFRESH_CONFLICT') clearAuthCookies(res);
    throw err; // the error handler sends the response
  }
}

// Step ①: the "Continue with Google" button links here. We remember the secrets of this
// attempt, then send the browser to Google's sign-in page.
export async function googleStart(req, res) {
  if (!isGoogleConfigured()) {
    throw new AppError(503, 'GOOGLE_NOT_CONFIGURED', 'Google sign-in is not configured');
  }
  const { url, state, nonce, codeVerifier } = createAuthRequest();
  const txId = await saveTransaction({ state, nonce, codeVerifier });
  setOAuthCookie(res, txId, OAUTH_TX_TTL_SECONDS);
  res.redirect(url); // 302 → accounts.google.com
}

// Google sends the browser back here. This is a page navigation, not an API call from
// JavaScript, so every outcome REDIRECTS back to the React app rather than returning JSON.
// Tokens are never put in the URL: they travel in the httpOnly cookies set on this redirect.
export async function googleCallback(req, res) {
  const { code, state, error } = req.validated.query;
  const txId = readOAuthCookie(req);
  clearOAuthCookie(res); // used once, whatever happens next

  const backToApp = (params) => res.redirect(`${env.clientUrl}/?${new URLSearchParams(params)}`);

  if (error) {
    await takeTransaction(txId); // user pressed "Cancel" at Google: throw the attempt away
    return backToApp({ login: 'cancelled' });
  }

  try {
    const { user: _, ...tokens } = await authService.loginWithGoogle(
      { code, state, txId },
      { userAgent: req.get('user-agent'), ip: req.ip },
    );
    setAuthCookies(res, tokens);
    backToApp({ login: 'google' });
  } catch (err) {
    if (!(err instanceof AppError)) console.error(err); // a real bug: log it on the server
    backToApp({ login: 'failed', reason: err instanceof AppError ? err.code : 'INTERNAL_ERROR' });
  }
}

// 204 No Content: success, nothing to send back.
export async function logout(req, res) {
  await authService.logout(readRefreshCookie(req));
  clearAuthCookies(res);
  res.status(204).end();
}

export async function logoutAll(req, res) {
  await authService.logoutAll(req.user.id);
  clearAuthCookies(res);
  res.status(204).end();
}

export async function listSessions(req, res) {
  res.json({ sessions: await authService.listSessions(req.user) });
}

export async function deleteSession(req, res) {
  await authService.revokeOwnSession(req.user.id, req.validated.params.id);
  res.status(204).end();
}

// Same answer for every email, on purpose (see requestPasswordReset).
export function forgotPassword(req, res) {
  authService.requestPasswordReset(req.validated.body.email);
  res.json({ message: 'If an account exists for this email, we have sent a link to reset the password.' });
}

export async function resetPassword(req, res) {
  await authService.resetPassword(req.validated.body);
  clearAuthCookies(res); // every session just ended; log in again with the new password
  res.status(204).end();
}

export async function me(req, res) {
  const user = await authService.getMe(req.user.id); // req.user was set by authenticate
  // A suspension or ban (Phase 5e), so every page can show it: null, or { kind, until, reason }.
  res.json({ user: { ...user, restriction: await restrictionFor(req.user.id) } });
}
