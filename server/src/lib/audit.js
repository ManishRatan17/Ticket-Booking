// The admin audit log (migration 014): who changed what, when. Append-only (the database refuses
// updates and deletes). Two ways in:
//   • auditAdminActions (middleware on the WHOLE admin router): every admin request that CHANGES
//     something (not GET) and SUCCEEDS is recorded automatically — "default audited", like the admin
//     router's "default deny". A new admin route can't forget it.
//   • writeAudit(): directly, for changes made outside HTTP (the set-role command-line script).
import { pool } from '../config/db.js';

// Readable names for the admin routes. A route not listed here is still recorded, as "PATCH /x/:id".
const ACTIONS = {
  'PATCH /users/:id/role': ['role.change', 'user'],
  'POST /events': ['event.create', 'event'],
  'PATCH /events/:id': ['event.update', 'event'],
  'POST /events/:id/cancel': ['event.cancel', 'event'],
  'POST /jobs/:id/retry': ['job.retry', 'job'],
  'POST /support/:id/messages': ['support.reply', 'support_request'],
  'POST /support/:id/decision': ['support.decide', 'support_request'],
  'POST /refunds/:id/retry': ['refund.retry', 'refund'],
  'POST /restrictions/acknowledge': ['restrictions.acknowledge', 'restriction'],
  'POST /restrictions': ['restriction.create', 'restriction'],
  'POST /restrictions/:id/lift': ['restriction.lift', 'restriction'],
};

// Long texts (support messages) are shortened; the full text stays where it lives.
function shorten(value) {
  if (typeof value === 'string') return value.length > 300 ? `${value.slice(0, 300)}…` : value;
  if (Array.isArray(value)) return value.map(shorten);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, shorten(v)]));
  return value;
}

export async function writeAudit({ adminId = null, adminEmail = null, action, targetType = null, targetId = null, details = {} }) {
  await pool.query(
    `INSERT INTO admin_audit_log (admin_id, admin_email, action, target_type, target_id, details)
     VALUES ($1, COALESCE($2, (SELECT email FROM users WHERE id = $1), 'unknown'), $3, $4, $5, $6)`,
    [adminId, adminEmail, action, targetType, targetId === null ? null : String(targetId), shorten(details)],
  );
}

export function auditAdminActions(req, res, next) {
  if (req.method === 'GET') return next();
  // After the response: we only know then whether it succeeded. (A crash in the instant between
  // could lose an entry: acceptable for an admin log; never lost for a successful response.)
  res.on('finish', () => {
    if (res.statusCode >= 400 || !req.route) return;
    const key = `${req.method} ${req.route.path}`;
    const [action, targetType] = ACTIONS[key] ?? [key, null];
    const targetId = req.params?.id ?? res.locals.auditTargetId ?? null;
    const details = { ...(req.validated?.body ?? {}), ...(res.locals.auditDetails ?? {}) };
    writeAudit({ adminId: req.user.id, action, targetType, targetId, details }).catch((err) =>
      console.error(`[audit] could not record ${action} by admin ${req.user.id}: ${err.message}`),
    );
  });
  next();
}

export async function listAudit({ action = null, limit = 200 } = {}) {
  const { rows } = await pool.query(
    `SELECT id, admin_id, admin_email, action, target_type, target_id, details, created_at
       FROM admin_audit_log WHERE ($1::text IS NULL OR action = $1::text)
      ORDER BY created_at DESC, id DESC LIMIT $2`,
    [action, limit],
  );
  return rows.map((r) => ({
    id: Number(r.id),
    adminId: r.admin_id === null ? null : Number(r.admin_id),
    adminEmail: r.admin_email,
    action: r.action,
    targetType: r.target_type,
    targetId: r.target_id,
    details: r.details,
    createdAt: r.created_at,
  }));
}
