// HOUSEKEEPING, once a day (the "housekeeping" job): tables that only ever grow are trimmed, so the
// database stays small and fast. Only data that is useless by now goes; RECORDS are never deleted
// (orders, sold tickets, refunds, support requests, restrictions, lucky-draw entries, the audit log).
//
//   sessions             expired or logged out > 30 days ago   (their refresh tokens go with them:
//                                                               ON DELETE CASCADE)
//   password reset links expired > 1 day ago                  (a link only works for 15 minutes)
//   processed webhooks   received > 30 days ago               (providers retry for hours or days,
//                                                               so repeats are still recognised)
// Redis needs nothing: everything there has its own expiry (TTL), and BullMQ trims finished jobs.
import { pool } from '../config/db.js';

export const RETENTION_DAYS = { sessions: 30, passwordResetTokens: 1, processedWebhooks: 30 };

export async function runHousekeeping() {
  const deleted = {};
  ({ rowCount: deleted.sessions } = await pool.query(
    `DELETE FROM sessions
      WHERE expires_at < now() - make_interval(days => $1)
         OR revoked_at < now() - make_interval(days => $1)`,
    [RETENTION_DAYS.sessions],
  ));
  ({ rowCount: deleted.passwordResetTokens } = await pool.query(
    'DELETE FROM password_reset_tokens WHERE expires_at < now() - make_interval(days => $1)',
    [RETENTION_DAYS.passwordResetTokens],
  ));
  ({ rowCount: deleted.processedWebhooks } = await pool.query(
    'DELETE FROM processed_webhooks WHERE received_at < now() - make_interval(days => $1)',
    [RETENTION_DAYS.processedWebhooks],
  ));
  return { deleted };
}
