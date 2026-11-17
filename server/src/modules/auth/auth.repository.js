// Data layer: SQL only. No business rules, no HTTP.
import { pool } from '../../config/db.js';

// Columns that are safe to send to clients. We list them explicitly instead of SELECT *,
// so a sensitive column added later (like password_hash) can never leak by accident.
const PUBLIC_USER_COLUMNS = 'id, email, role, created_at';

// Turns a database row (snake_case) into the object the rest of the app uses (camelCase).
function toUser(row) {
  return {
    // pg returns BIGINT as a string, because JS numbers can't hold every 64-bit integer.
    // User ids will never get near 2^53, so converting to a number is safe.
    id: Number(row.id),
    email: row.email,
    role: row.role,
    createdAt: row.created_at,
  };
}

// Throws a Postgres unique-violation error (constraint "users_email_key") if the email exists.
export async function createUser({ email, passwordHash }) {
  const { rows } = await pool.query(
    `INSERT INTO users (email, password_hash)
     VALUES ($1, $2)
     RETURNING ${PUBLIC_USER_COLUMNS}`,
    [email, passwordHash], // $1, $2 placeholders: values are sent separately → no SQL injection
  );
  return toUser(rows[0]);
}
