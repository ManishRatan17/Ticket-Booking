// SQL for sessions and refresh tokens. Every function takes a `client` (a connection that
// is inside a transaction), so the service can group several of them atomically.

export async function createSession(client, { userId, userAgent, ip, expiresAt }) {
  const { rows } = await client.query(
    `INSERT INTO sessions (user_id, user_agent, ip, expires_at)
     VALUES ($1, $2, $3, $4)
     RETURNING id`,
    [userId, userAgent, ip, expiresAt],
  );
  return rows[0].id;
}

export async function insertRefreshToken(client, { sessionId, tokenHash, expiresAt }) {
  const { rows } = await client.query(
    `INSERT INTO refresh_tokens (session_id, token_hash, expires_at)
     VALUES ($1, $2, $3)
     RETURNING id`,
    [sessionId, tokenHash, expiresAt],
  );
  return rows[0].id;
}

// THE atomic step of rotation: mark the token used ONLY IF it is unused and unexpired.
// Postgres locks the row while updating, so if 10 requests race with the same token,
// exactly one sees "used_at IS NULL" — the others match nothing.
// Returns the session/user info for the winner, or null.
export async function claimRefreshToken(client, tokenHash) {
  const { rows } = await client.query(
    `UPDATE refresh_tokens AS rt
        SET used_at = now()
       FROM sessions AS s
       JOIN users AS u ON u.id = s.user_id
      WHERE rt.token_hash = $1
        AND rt.used_at IS NULL
        AND rt.expires_at > now()
        AND s.id = rt.session_id
     RETURNING rt.id, rt.session_id, s.revoked_at, s.expires_at AS session_expires_at,
               u.id AS user_id, u.role`,
    [tokenHash],
  );
  if (rows.length === 0) return null;
  const row = rows[0];
  return {
    tokenId: row.id,
    sessionId: row.session_id,
    sessionRevoked: row.revoked_at !== null,
    sessionExpiresAt: row.session_expires_at,
    user: { id: Number(row.user_id), role: row.role },
  };
}

// Used when the claim failed, to find out WHY.
// Time is measured by the DATABASE clock (now() - used_at), so Node's clock can't skew it.
export async function findRefreshToken(client, tokenHash) {
  const { rows } = await client.query(
    `SELECT session_id, used_at,
            EXTRACT(EPOCH FROM now() - used_at) AS seconds_since_used
       FROM refresh_tokens
      WHERE token_hash = $1`,
    [tokenHash],
  );
  if (rows.length === 0) return null;
  return {
    sessionId: rows[0].session_id,
    used: rows[0].used_at !== null,
    secondsSinceUsed: rows[0].seconds_since_used === null ? null : Number(rows[0].seconds_since_used),
  };
}

// Builds the chain R1 → R2 → R3, so we can trace a session's token history.
export async function linkReplacement(client, oldTokenId, newTokenId) {
  await client.query('UPDATE refresh_tokens SET replaced_by = $2 WHERE id = $1', [oldTokenId, newTokenId]);
}

export async function touchSession(client, sessionId) {
  await client.query('UPDATE sessions SET last_used_at = now() WHERE id = $1', [sessionId]);
}

// ---- Revoking ----
// ⚠️ Don't call these directly: use revocation.js, which also updates Redis.
// Each returns the ids it ACTUALLY revoked. "AND revoked_at IS NULL" means revoking
// twice keeps the FIRST time and reason, and the second call returns [] (idempotent).

export async function revokeSession(client, sessionId, reason) {
  const { rows } = await client.query(
    `UPDATE sessions SET revoked_at = now(), revoke_reason = $2
      WHERE id = $1 AND revoked_at IS NULL
     RETURNING id`,
    [sessionId, reason],
  );
  return rows.map((r) => r.id);
}

export async function revokeAllUserSessions(client, userId, reason) {
  const { rows } = await client.query(
    `UPDATE sessions SET revoked_at = now(), revoke_reason = $2
      WHERE user_id = $1 AND revoked_at IS NULL
     RETURNING id`,
    [userId, reason],
  );
  return rows.map((r) => r.id);
}

// The ownership check is IN the query: someone else's session simply matches no row.
export async function revokeOwnSession(client, { sessionId, userId }, reason) {
  const { rows } = await client.query(
    `UPDATE sessions SET revoked_at = now(), revoke_reason = $3
      WHERE id = $1 AND user_id = $2 AND revoked_at IS NULL
     RETURNING id`,
    [sessionId, userId, reason],
  );
  return rows.map((r) => r.id);
}

// ---- Reading ----

// Which session does this refresh token (used or not) belong to? Used by logout.
export async function findSessionIdByRefreshToken(client, tokenHash) {
  const { rows } = await client.query('SELECT session_id FROM refresh_tokens WHERE token_hash = $1', [
    tokenHash,
  ]);
  return rows[0]?.session_id ?? null;
}

// Active sessions only: not revoked and not past their 30-day limit. Most recent first.
export async function listActiveSessions(client, userId) {
  const { rows } = await client.query(
    `SELECT id, user_agent, ip, created_at, last_used_at, expires_at
       FROM sessions
      WHERE user_id = $1 AND revoked_at IS NULL AND expires_at > now()
      ORDER BY last_used_at DESC`,
    [userId],
  );
  return rows.map((r) => ({
    id: r.id,
    userAgent: r.user_agent,
    ip: r.ip,
    createdAt: r.created_at,
    lastUsedAt: r.last_used_at,
    expiresAt: r.expires_at,
  }));
}
