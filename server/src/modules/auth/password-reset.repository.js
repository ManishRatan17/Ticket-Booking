// SQL for "forgot password" tokens (table created in migration 002).
// Like refresh tokens, only the SHA-256 HASH of a reset token is ever stored.

export async function insertResetToken(client, { userId, tokenHash, expiresAt }) {
  await client.query(
    `INSERT INTO password_reset_tokens (user_id, token_hash, expires_at) VALUES ($1, $2, $3)`,
    [userId, tokenHash, expiresAt],
  );
}

// Kills every still-usable link of this user (marks them used). Called when a NEW link is
// requested — only the latest email works — and after a successful reset.
export async function cancelUnusedResetTokens(client, userId) {
  await client.query(
    `UPDATE password_reset_tokens SET used_at = now() WHERE user_id = $1 AND used_at IS NULL`,
    [userId],
  );
}

// The atomic single-use step, the same pattern as claiming a refresh token (A4):
// only ONE request can turn used_at from NULL into a time. Returns the user, or null.
export async function claimResetToken(client, tokenHash) {
  const { rows } = await client.query(
    `UPDATE password_reset_tokens AS t
        SET used_at = now()
       FROM users AS u
      WHERE t.token_hash = $1 AND t.used_at IS NULL AND t.expires_at > now()
        AND u.id = t.user_id
     RETURNING u.id, u.email`,
    [tokenHash],
  );
  return rows.length === 0 ? null : { id: Number(rows[0].id), email: rows[0].email };
}

// Using the emailed link PROVES the user owns the email, so it also counts as verification.
export async function setPassword(client, userId, passwordHash) {
  await client.query(
    `UPDATE users
        SET password_hash = $2,
            password_changed_at = now(),
            email_verified_at = COALESCE(email_verified_at, now())
      WHERE id = $1`,
    [userId, passwordHash],
  );
}
