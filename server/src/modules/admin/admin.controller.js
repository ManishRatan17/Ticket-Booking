import * as adminService from './admin.service.js';

export async function listUsers(req, res) {
  res.json(await adminService.listUsers(req.validated.query));
}

export async function changeRole(req, res) {
  const user = await adminService.changeRole({
    actorId: req.user.id,
    targetId: req.validated.params.id,
    role: req.validated.body.role,
  });
  res.json({ user });
}
