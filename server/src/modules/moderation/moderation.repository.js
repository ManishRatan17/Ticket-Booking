// SQL for account restrictions (migration 010). Functions take a `client` (the pool, or a transaction).

const COLUMNS = `r.id, r.user_id, u.email AS user_email, r.kind, r.reason, r.evidence, r.starts_at, r.ends_at,
                 r.created_by, r.lifted_at, r.lift_reason, r.overturned, r.acknowledged_at`;

function toRestriction(row) {
  return {
    id: Number(row.id),
    userId: Number(row.user_id),
    userEmail: row.user_email,
    kind: row.kind, // suspended | banned
    reason: row.reason,
    evidence: row.evidence,
    startsAt: row.starts_at,
    endsAt: row.ends_at, // null = permanent
    automatic: row.created_by === null,
    liftedAt: row.lifted_at,
    liftReason: row.lift_reason,
    overturned: row.overturned,
    acknowledgedAt: row.acknowledged_at, // null = a NEW automatic restriction no admin has seen yet
  };
}

// "In force" = not lifted, and not over yet (a ban never ends). A suspension simply STOPS being in
// force when ends_at passes: reopening the account needs no job at all.
const IN_FORCE = `r.lifted_at IS NULL AND (r.ends_at IS NULL OR r.ends_at > now())`;

export async function activeRestriction(client, userId) {
  const { rows } = await client.query(
    `SELECT ${COLUMNS} FROM account_restrictions AS r JOIN users AS u ON u.id = r.user_id
      WHERE r.user_id = $1 AND ${IN_FORCE}
      ORDER BY r.ends_at DESC NULLS FIRST LIMIT 1`,
    [userId],
  );
  return rows.length === 0 ? null : toRestriction(rows[0]);
}

// Strikes that count: in the last 365 days, and not overturned (a mistake doesn't count).
export async function countStrikes(client, userId) {
  const { rows } = await client.query(
    `SELECT count(*)::int AS n FROM account_restrictions
      WHERE user_id = $1 AND NOT overturned AND starts_at > now() - interval '365 days'`,
    [userId],
  );
  return rows[0].n;
}

export async function insertRestriction(client, { userId, kind, reason, evidence, days, createdBy }) {
  const { rows } = await client.query(
    `INSERT INTO account_restrictions (user_id, kind, reason, evidence, ends_at, created_by, acknowledged_at)
     VALUES ($1, $2, $3, $4, CASE WHEN $2 = 'banned' THEN NULL ELSE now() + make_interval(days => $5::int) END, $6,
             CASE WHEN $6::bigint IS NULL THEN NULL ELSE now() END)  -- an admin's own restriction is already "seen"
     RETURNING id`,
    [userId, kind, reason, evidence, days, createdBy],
  );
  return Number(rows[0].id);
}

export async function findRestriction(client, id) {
  const { rows } = await client.query(
    `SELECT ${COLUMNS} FROM account_restrictions AS r JOIN users AS u ON u.id = r.user_id WHERE r.id = $1`,
    [id],
  );
  return rows.length === 0 ? null : toRestriction(rows[0]);
}

export async function listRestrictions(client, { activeOnly }) {
  const { rows } = await client.query(
    `SELECT ${COLUMNS} FROM account_restrictions AS r JOIN users AS u ON u.id = r.user_id
      WHERE ($1::boolean IS NOT TRUE OR (${IN_FORCE}))
      ORDER BY r.starts_at DESC LIMIT 200`,
    [activeOnly],
  );
  return rows.map(toRestriction);
}

// Lift every restriction of this person that is in force. Returns how many were lifted.
export async function liftActive(client, { userId, adminId, reason, overturn }) {
  const { rowCount } = await client.query(
    `UPDATE account_restrictions AS r SET lifted_at = now(), lifted_by = $2, lift_reason = $3, overturned = $4
      WHERE r.user_id = $1 AND ${IN_FORCE}`,
    [userId, adminId, reason, overturn],
  );
  return rowCount;
}

// New automatic restrictions: how many, and the latest few (for the admin's notification badge).
export async function unseenRestrictions(client, limit = 5) {
  const { rows } = await client.query(
    `SELECT ${COLUMNS}, count(*) OVER ()::int AS total
       FROM account_restrictions AS r JOIN users AS u ON u.id = r.user_id
      WHERE r.acknowledged_at IS NULL
      ORDER BY r.starts_at DESC LIMIT $1`,
    [limit],
  );
  return { count: rows[0]?.total ?? 0, latest: rows.map(toRestriction) };
}

export async function acknowledgeAll(client, adminId) {
  const { rowCount } = await client.query(
    'UPDATE account_restrictions SET acknowledged_at = now(), acknowledged_by = $1 WHERE acknowledged_at IS NULL',
    [adminId],
  );
  return rowCount;
}

export async function lockUser(client, userId) {
  const { rows } = await client.query('SELECT id FROM users WHERE id = $1 FOR UPDATE', [userId]);
  return rows.length > 0;
}

export async function findUserIdByEmail(client, email) {
  const { rows } = await client.query('SELECT id FROM users WHERE email = $1', [email]);
  return rows.length === 0 ? null : Number(rows[0].id);
}

// Unpaid orders of a restricted person are given up (their held tickets go back on sale).
export async function expirePendingOrders(client, userId) {
  const { rows } = await client.query(
    `UPDATE orders SET status = 'expired', updated_at = now() WHERE user_id = $1 AND status = 'pending' RETURNING hold_id`,
    [userId],
  );
  return rows.map((r) => r.hold_id).filter(Boolean);
}
