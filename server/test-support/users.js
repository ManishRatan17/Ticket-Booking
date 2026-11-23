// Creates many signed-in users FAST, for tests that need hundreds of them.
//
// Logging in 300 users would run argon2 300 times (~10-20 s). Instead we create the same
// things a login creates — a user row, a session row and an access token signed by the
// REAL token code — directly. Everything AFTER login (cookies, CSRF guard, authenticate,
// revocation check, validation, Lua) still runs for real. Login itself has its own tests.
import { pool } from '../src/config/db.js';
import { signAccessToken } from '../src/modules/auth/tokens.js';
import { cookieHeader } from './cookies.js';

export async function createSignedInUsers(count, { prefix, role = 'user' }) {
  // password_hash 'test-no-login' is not a valid argon2 hash: these users can't log in with a password.
  const { rows: users } = await pool.query(
    `INSERT INTO users (email, password_hash, role)
     SELECT $1 || '-' || g || '@example.com', 'test-no-login', $2
       FROM generate_series(1, $3) AS g
     RETURNING id, email, role`,
    [prefix, role, count],
  );
  const { rows: sessions } = await pool.query(
    `INSERT INTO sessions (user_id, expires_at)
     SELECT unnest($1::bigint[]), now() + interval '1 day'
     RETURNING id, user_id`,
    [users.map((u) => u.id)],
  );
  const sessionOf = new Map(sessions.map((s) => [String(s.user_id), s.id]));

  return Promise.all(
    users.map(async (u) => {
      const user = { id: Number(u.id), email: u.email, role: u.role };
      const accessToken = await signAccessToken(user, sessionOf.get(String(u.id)));
      return { ...user, accessToken, cookie: cookieHeader({ access_token: accessToken }) };
    }),
  );
}
