// SQL for the support inbox (migration 009). Functions take a `client` (the pool, or a transaction).

const REQUEST_SELECT = `
  SELECT r.id, r.user_id, u.email AS user_email, r.kind, r.event_id, e.name AS event_name, r.extra_tickets,
         r.status, r.decided_at, r.created_at, r.updated_at,
         (SELECT max(m.created_at) FROM support_messages AS m WHERE m.request_id = r.id) AS last_message_at,
         (SELECT m.from_admin FROM support_messages AS m WHERE m.request_id = r.id ORDER BY m.id DESC LIMIT 1) AS last_from_admin
    FROM support_requests AS r
    JOIN users AS u ON u.id = r.user_id
    LEFT JOIN events AS e ON e.id = r.event_id`;

function toRequest(row) {
  return {
    id: Number(row.id),
    userId: Number(row.user_id),
    userEmail: row.user_email,
    kind: row.kind,
    eventId: row.event_id === null ? null : Number(row.event_id),
    eventName: row.event_name,
    extraTickets: row.extra_tickets,
    status: row.status, // open → approved | declined | closed
    decidedAt: row.decided_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastMessageAt: row.last_message_at,
    awaitingReply: row.status === 'open' && row.last_from_admin === false, // the person spoke last
  };
}

export async function insertRequest(client, { userId, kind, eventId, extraTickets }) {
  const { rows } = await client.query(
    `INSERT INTO support_requests (user_id, kind, event_id, extra_tickets) VALUES ($1, $2, $3, $4) RETURNING id`,
    [userId, kind, eventId, extraTickets],
  );
  return Number(rows[0].id);
}

export async function insertMessage(client, { requestId, authorId, fromAdmin, body }) {
  await client.query(`INSERT INTO support_messages (request_id, author_id, from_admin, body) VALUES ($1, $2, $3, $4)`, [
    requestId,
    authorId,
    fromAdmin,
    body,
  ]);
  await client.query('UPDATE support_requests SET updated_at = now() WHERE id = $1', [requestId]);
}

export async function findOpenRequestId(client, { userId, kind, eventId }) {
  const { rows } = await client.query(
    `SELECT id FROM support_requests WHERE user_id = $1 AND kind = $2 AND COALESCE(event_id, 0) = COALESCE($3::bigint, 0) AND status = 'open'`,
    [userId, kind, eventId],
  );
  return rows.length === 0 ? null : Number(rows[0].id);
}

// Ownership in the query: someone else's request simply isn't found (→ 404, never 403: IDOR).
export async function findRequest(client, id, { userId } = {}) {
  const { rows } = await client.query(
    `${REQUEST_SELECT} WHERE r.id = $1 AND ($2::bigint IS NULL OR r.user_id = $2::bigint)`,
    [id, userId ?? null],
  );
  return rows.length === 0 ? null : toRequest(rows[0]);
}

export async function listRequestsForUser(client, userId) {
  const { rows } = await client.query(`${REQUEST_SELECT} WHERE r.user_id = $1 ORDER BY r.updated_at DESC LIMIT 100`, [userId]);
  return rows.map(toRequest);
}

// Admin list: open ones first, OLDEST first (whoever asked first gets an answer first).
export async function listRequests(client, { status }) {
  const { rows } = await client.query(
    `${REQUEST_SELECT} WHERE ($1::text IS NULL OR r.status = $1::text)
      ORDER BY (r.status = 'open') DESC, r.created_at ASC LIMIT 200`,
    [status ?? null],
  );
  return rows.map(toRequest);
}

// The person never learns WHICH admin answered: only that it came from the organisers.
export async function listMessages(client, requestId) {
  const { rows } = await client.query(
    'SELECT id, from_admin, body, created_at FROM support_messages WHERE request_id = $1 ORDER BY id',
    [requestId],
  );
  return rows.map((r) => ({ id: Number(r.id), fromAdmin: r.from_admin, body: r.body, createdAt: r.created_at }));
}

// open → decided, ONLY from open (UPDATE … WHERE status = 'open'): two admins deciding at the same
// moment can't both win. Returns the request row, or null if it wasn't open (any more).
export async function decide(client, { id, status, adminId }) {
  const { rows } = await client.query(
    `UPDATE support_requests SET status = $2, decided_by = $3, decided_at = now(), updated_at = now()
      WHERE id = $1 AND status = 'open'
      RETURNING id, user_id, kind, event_id, extra_tickets`,
    [id, status, adminId],
  );
  return rows[0] ?? null;
}

// An approved "more tickets" request raises the limit. A later approval for the same person and
// event replaces the earlier one (the newest decision counts).
export async function grantExtraTickets(client, { eventId, userId, extra, requestId, adminId }) {
  await client.query(
    `INSERT INTO purchase_limit_overrides (event_id, user_id, extra, request_id, granted_by)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (event_id, user_id)
     DO UPDATE SET extra = EXCLUDED.extra, request_id = EXCLUDED.request_id, granted_by = EXCLUDED.granted_by, created_at = now()`,
    [eventId, userId, extra, requestId, adminId],
  );
}
