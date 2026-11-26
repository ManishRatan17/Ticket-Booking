// Admin rules. Used by the HTTP API AND by the set-role command-line script.
import { pool, withTransaction } from '../../config/db.js';
import { AppError } from '../../lib/errors.js';
import * as revocation from '../auth/revocation.js';
import * as adminRepository from './admin.repository.js';
import { writeAudit } from '../../lib/audit.js';

export async function listUsers({ limit, offset }) {
  const page = await adminRepository.listUsers(pool, { limit, offset });
  return { ...page, limit, offset };
}

// Changes a user's role.
//   actorId = the admin making the change, or null when run from the command line
//             (having shell access to the server is the authority there).
//
// Rules:
//   • demotion (admin → user) revokes ALL the user's sessions: losing power is instant
//   • promotion needs nothing: the next /refresh reads the new role from the database
//   • the last remaining admin can never be demoted (nobody could manage the system)
export async function changeRole({ actorId, targetId, role }) {
  const result = await withTransaction(async (client) => {
    const adminIds = await adminRepository.lockAdminIds(client);

    // Re-check the ACTOR inside the transaction. The request was authorized a moment ago,
    // but another admin may have demoted them since (time-of-check vs time-of-use).
    if (actorId !== null && !adminIds.includes(actorId)) return { outcome: 'forbidden' };

    const target = await adminRepository.findUserForUpdate(client, targetId);
    if (!target) return { outcome: 'not_found' };
    if (target.role === role) return { outcome: 'ok', user: target, from: role };

    const demotingAnAdmin = target.role === 'admin' && role !== 'admin';
    if (demotingAnAdmin && adminIds.length <= 1) return { outcome: 'last_admin' };

    const user = await adminRepository.setRole(client, targetId, role);
    if (demotingAnAdmin) {
      await revocation.revokeAllUserSessions(client, targetId, 'admin');
    }
    return { outcome: 'ok', user, from: target.role };
  });

  switch (result.outcome) {
    case 'forbidden':
      throw new AppError(403, 'FORBIDDEN', 'You do not have permission to do this');
    case 'not_found':
      throw new AppError(404, 'USER_NOT_FOUND', 'No user with this id');
    case 'last_admin':
      throw new AppError(409, 'LAST_ADMIN', 'Cannot demote the last admin');
    default:
      if (result.from !== result.user.role) {
        // Also printed in the server log. The permanent record is the audit log table (lib/audit.js):
        // HTTP changes are recorded by its middleware, command-line ones by changeRoleByEmail below.
        console.log(
          `[audit] ${actorId === null ? 'command line' : `admin ${actorId}`} changed user ` +
            `${result.user.id} (${result.user.email}): ${result.from} → ${result.user.role}`,
        );
      }
      return result.user;
  }
}

export async function changeRoleByEmail({ email, role }) {
  const targetId = await adminRepository.findUserIdByEmail(pool, email);
  if (targetId === null) throw new AppError(404, 'USER_NOT_FOUND', `No user with email ${email}`);
  const user = await changeRole({ actorId: null, targetId, role });
  // Recorded too: a change from the command line is still an admin action.
  await writeAudit({ adminEmail: 'command line (set-role)', action: 'role.change', targetType: 'user', targetId, details: { email, role } });
  return user;
}
