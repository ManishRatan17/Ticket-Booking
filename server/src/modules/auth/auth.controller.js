// HTTP layer: read validated input from the request, call the service, send the response.
import { env } from '../../config/env.js';
import { AppError } from '../../lib/errors.js';
import * as authService from './auth.service.js';
import { isGoogleConfigured, createAuthRequest } from './google.js';
import { saveTransaction, takeTransaction, OAUTH_TX_TTL_SECONDS } from './oauth-transactions.js';
import {
  setRefreshCookie,
  clearRefreshCookie,
  readRefreshCookie,
  setOAuthCookie,
  clearOAuthCookie,
  readOAuthCookie,
} from './auth.cookies.js';

export async function register(req, res) {
  const user = await authService.register(req.validated.body);
  res.status(201).json({ user }); // 201 Created
}

export async function login(req, res) {
  const { refresh, ...body } = await authService.login(req.validated.body, {
    userAgent: req.get('user-agent'),
    ip: req.ip,
  });
  setRefreshCookie(res, refresh); // refresh token → httpOnly cookie, NOT the JSON body
  res.json(body); // 200 OK
}

export async function refresh(req, res) {
  try {
    const { refresh: next, ...body } = await authService.refresh(readRefreshCookie(req));
    setRefreshCookie(res, next);
    res.json(body);
  } catch (err) {
    // A dead token should be removed from the browser. But NOT on a 409 conflict:
    // the other tab's response has just stored the NEW token in this same cookie,
    // and clearing it would log the user out.
    if (err.code !== 'REFRESH_CONFLICT') clearRefreshCookie(res);
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
// Tokens are never put in the URL: the result travels in the httpOnly refresh cookie,
// and the app then calls POST /api/auth/refresh to get an access token.
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
    const { refresh } = await authService.loginWithGoogle(
      { code, state, txId },
      { userAgent: req.get('user-agent'), ip: req.ip },
    );
    setRefreshCookie(res, refresh);
    backToApp({ login: 'google' });
  } catch (err) {
    if (!(err instanceof AppError)) console.error(err); // a real bug: log it on the server
    backToApp({ login: 'failed', reason: err instanceof AppError ? err.code : 'INTERNAL_ERROR' });
  }
}

// 204 No Content: success, nothing to send back.
export async function logout(req, res) {
  await authService.logout(readRefreshCookie(req));
  clearRefreshCookie(res);
  res.status(204).end();
}

export async function logoutAll(req, res) {
  await authService.logoutAll(req.user.id);
  clearRefreshCookie(res);
  res.status(204).end();
}

export async function listSessions(req, res) {
  res.json({ sessions: await authService.listSessions(req.user) });
}

export async function deleteSession(req, res) {
  await authService.revokeOwnSession(req.user.id, req.validated.params.id);
  res.status(204).end();
}

export async function me(req, res) {
  const user = await authService.getMe(req.user.id); // req.user was set by authenticate
  res.json({ user });
}
