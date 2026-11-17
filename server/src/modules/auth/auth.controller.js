// HTTP layer: read validated input from the request, call the service, send the response.
import * as authService from './auth.service.js';

export async function register(req, res) {
  const user = await authService.register(req.validated.body);
  res.status(201).json({ user }); // 201 Created
}
