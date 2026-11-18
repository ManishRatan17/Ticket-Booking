// Make someone an admin (or a normal user again) from the command line:
//
//   npm run set-role -- ann@example.com admin
//   npm run set-role -- ann@example.com user
//
// This is how the FIRST admin is created: there is no public API for it on purpose.
// Whoever can run commands on the server is already trusted with everything.
// It calls the same service as the admin API, so the same rules apply
// (demotion revokes sessions; the last admin can't be demoted).
import { changeRoleByEmail } from '../src/modules/admin/admin.service.js';
import { ROLES } from '../src/modules/admin/admin.schemas.js';
import { closeConnections } from '../src/config/connections.js';

const [email, role] = process.argv.slice(2);

try {
  if (!email || !ROLES.includes(role)) {
    console.error(`Usage: npm run set-role -- <email> <${ROLES.join('|')}>`);
    process.exitCode = 1;
  } else {
    const user = await changeRoleByEmail({ email: email.trim().toLowerCase(), role });
    console.log(`${user.email} is now: ${user.role}`);
  }
} catch (err) {
  console.error(err.message);
  process.exitCode = 1;
} finally {
  await closeConnections();
}
