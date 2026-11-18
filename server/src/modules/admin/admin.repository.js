// SQL for admin features. Functions take a `client` (pool or a transaction's connection).

// One page of users. "count(*) OVER ()" is a WINDOW FUNCTION: it adds the total number of
// matching rows to every row, so one query returns both the page AND the total for paging.
export async function listUsers(client, { limit, offset }) {
  const { rows } = await client.query(
    `SELECT u.id, u.email, u.role, u.created_at,
            u.password_hash IS NOT NULL AS has_password,   -- a yes/no, never the hash itself
            EXISTS (SELECT 1 FROM user_identities i
                     WHERE i.user_id = u.id AND i.provider = 'google') AS has_google,
            count(*) OVER () AS total
       FROM users u
      ORDER BY u.id
      LIMIT $1 OFFSET $2`,
    [limit, offset],
  );
  return {
    total: rows.length > 0 ? Number(rows[0].total) : 0,
    users: rows.map((r) => ({
      id: Number(r.id),
      email: r.email,
      role: r.role,
      createdAt: r.created_at,
      hasPassword: r.has_password,
      hasGoogle: r.has_google,
    })),
  };
}

// Locks EVERY admin row until the transaction ends, in id order.
// While we hold these locks, no other transaction can change who is an admin, so
// "how many admins are there?" stays true until we commit (no check-then-act race).
// Always locking in the same (id) order means two transactions can't deadlock.
export async function lockAdminIds(client) {
  const { rows } = await client.query(`SELECT id FROM users WHERE role = 'admin' ORDER BY id FOR UPDATE`);
  return rows.map((r) => Number(r.id));
}

export async function findUserForUpdate(client, id) {
  const { rows } = await client.query('SELECT id, email, role FROM users WHERE id = $1 FOR UPDATE', [id]);
  return rows.length === 0 ? null : { id: Number(rows[0].id), email: rows[0].email, role: rows[0].role };
}

export async function findUserIdByEmail(client, email) {
  const { rows } = await client.query('SELECT id FROM users WHERE email = $1', [email]);
  return rows.length === 0 ? null : Number(rows[0].id);
}

export async function setRole(client, id, role) {
  const { rows } = await client.query(
    'UPDATE users SET role = $2 WHERE id = $1 RETURNING id, email, role, created_at',
    [id, role],
  );
  const r = rows[0];
  return { id: Number(r.id), email: r.email, role: r.role, createdAt: r.created_at };
}
