// SQL for events (table created in migration 001). Postgres is the source of truth;
// Redis only keeps a fast working copy of each event's stock.
import { pool } from '../../config/db.js';

const COLUMNS = 'id, name, total_tickets, sale_starts_at, created_at';

function toEvent(row) {
  return {
    id: Number(row.id),
    name: row.name,
    totalTickets: row.total_tickets,
    saleStartsAt: row.sale_starts_at,
    createdAt: row.created_at,
  };
}

export async function createEvent({ name, totalTickets, saleStartsAt }) {
  const { rows } = await pool.query(
    `INSERT INTO events (name, total_tickets, sale_starts_at) VALUES ($1, $2, $3) RETURNING ${COLUMNS}`,
    [name, totalTickets, saleStartsAt],
  );
  return toEvent(rows[0]);
}

export async function listEvents() {
  const { rows } = await pool.query(`SELECT ${COLUMNS} FROM events ORDER BY sale_starts_at, id`);
  return rows.map(toEvent);
}

export async function findEventById(id) {
  const { rows } = await pool.query(`SELECT ${COLUMNS} FROM events WHERE id = $1`, [id]);
  return rows.length === 0 ? null : toEvent(rows[0]);
}

// Tickets that are SOLD for good (paid orders, Phase 2). Used to rebuild Redis stock.
export async function countSoldTickets(eventId) {
  const { rows } = await pool.query('SELECT count(*)::int AS sold FROM sold_tickets WHERE event_id = $1', [eventId]);
  return rows[0].sold;
}
