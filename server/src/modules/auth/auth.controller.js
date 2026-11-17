// HTTP layer: read validated input from the request, call the service, send the response.
import * as authService from './auth.service.js';

export async function register(req, res) {
  const user = await authService.register(req.validated.body);
  res.status(201).json({ user }); // 201 Created
}

export async function login(req, res) {
  const result = await authService.login(req.validated.body);
  res.json(result); // 200 OK
}

export async function me(req, res) {
  const user = await authService.getMe(req.user.id); // req.user was set by authenticate
  res.json({ user });
}
