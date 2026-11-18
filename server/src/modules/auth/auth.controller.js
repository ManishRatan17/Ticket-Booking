// HTTP layer: read validated input from the request, call the service, send the response.
import * as authService from './auth.service.js';
import { setRefreshCookie, clearRefreshCookie, readRefreshCookie } from './auth.cookies.js';

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

export async function me(req, res) {
  const user = await authService.getMe(req.user.id); // req.user was set by authenticate
  res.json({ user });
}
