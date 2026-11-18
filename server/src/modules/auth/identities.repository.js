// SQL for linking external logins (Google) to our users.
// Every function takes a `client` that is inside a transaction.
import { PUBLIC_USER_COLUMNS, toUser } from './auth.repository.js';

const userColumns = (alias) =>
  PUBLIC_USER_COLUMNS.split(', ').map((c) => `${alias}.${c}`).join(', ');

// The user already linked to this Google account, or null.
export async function findUserByIdentity(client, provider, providerUserId) {
  const { rows } = await client.query(
    `SELECT ${userColumns('u')}
       FROM user_identities i JOIN users u ON u.id = i.user_id
      WHERE i.provider = $1 AND i.provider_user_id = $2`,
    [provider, providerUserId],
  );
  return rows.length === 0 ? null : toUser(rows[0]);
}

// FOR UPDATE locks the user row until our transaction ends, so two sign-ins for the
// same email can't both decide "link it" at the same moment (check-then-act again).
export async function findUserByEmailForUpdate(client, email) {
  const { rows } = await client.query(
    `SELECT ${PUBLIC_USER_COLUMNS}, email_verified_at FROM users WHERE email = $1 FOR UPDATE`,
    [email],
  );
  if (rows.length === 0) return null;
  return { ...toUser(rows[0]), emailVerifiedAt: rows[0].email_verified_at };
}

// A Google user: no password, and the email is verified (Google proved it).
// Throws unique-violation "users_email_key" if someone registered this email meanwhile.
export async function createVerifiedUser(client, email) {
  const { rows } = await client.query(
    `INSERT INTO users (email, password_hash, email_verified_at)
     VALUES ($1, NULL, now())
     RETURNING ${PUBLIC_USER_COLUMNS}`,
    [email],
  );
  return toUser(rows[0]);
}

// "Verified email wins": the password was set by whoever typed this email first,
// with no proof they own it. It is removed; the real owner can set a new one via reset.
export async function removePasswordAndMarkVerified(client, userId) {
  await client.query(
    `UPDATE users SET password_hash = NULL, email_verified_at = now(), password_changed_at = now()
      WHERE id = $1`,
    [userId],
  );
}

export async function markEmailVerified(client, userId) {
  await client.query(
    'UPDATE users SET email_verified_at = COALESCE(email_verified_at, now()) WHERE id = $1',
    [userId],
  );
}

export async function insertIdentity(client, { userId, provider, providerUserId, email }) {
  await client.query(
    `INSERT INTO user_identities (user_id, provider, provider_user_id, email)
     VALUES ($1, $2, $3, $4)`,
    [userId, provider, providerUserId, email],
  );
}

export async function touchIdentity(client, provider, providerUserId) {
  await client.query(
    `UPDATE user_identities SET last_login_at = now()
      WHERE provider = $1 AND provider_user_id = $2`,
    [provider, providerUserId],
  );
}
