// "Last admin" tests need to be the ONLY admins in the database: the server refuses to demote
// the last admin by counting EVERY admin. Test files run in parallel and share the database, so
// another file's admin appearing mid-test makes that test fail (seen once the dev database had
// no admin of its own left to make those tests skip).
//
// A PostgreSQL advisory lock — a named lock that exists only in the database — coordinates them:
//   • files that CREATE admins hold it SHARED while their admins exist (many files at once is fine)
//   • the "last admin" tests take it EXCLUSIVE: they wait until no other file has an admin, and
//     while they run, no file can create one.
// Session-level locks belong to one connection, so each holder keeps its own pool client.
import { pool } from '../src/config/db.js';

const ADMINS_LOCK = 740_001; // any number, as long as every test file uses the same one

async function take(mode) {
  const client = await pool.connect();
  const [lock, unlock] =
    mode === 'shared' ? ['pg_advisory_lock_shared', 'pg_advisory_unlock_shared'] : ['pg_advisory_lock', 'pg_advisory_unlock'];
  await client.query(`SELECT ${lock}($1)`, [ADMINS_LOCK]);
  return async function release() {
    await client.query(`SELECT ${unlock}($1)`, [ADMINS_LOCK]);
    client.release();
  };
}

// Call before creating admin users; call the returned function after deleting them.
export const holdWhileCreatingAdmins = () => take('shared');
// For tests that must be the only admins.
export const holdAsOnlyAdmins = () => take('exclusive');
