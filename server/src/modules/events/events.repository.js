// SQL for events (table created in migration 001). Postgres is the source of truth;
// Redis only keeps a fast working copy of each event's stock.
import { pool } from '../../config/db.js';

const COLUMNS = `id, name, total_tickets, tickets_sold, sale_starts_at, price_paise, admission_per_second, lobby_minutes,
  lottery_percent, lottery_tickets, lottery_draw_minutes, lottery_per_winner, lottery_closed_at, created_at`;

function toEvent(row) {
  return {
    id: Number(row.id),
    name: row.name,
    totalTickets: row.total_tickets,
    ticketsSold: row.tickets_sold, // PAID tickets (Phase 2); = totalTickets means sold out for good
    saleStartsAt: row.sale_starts_at,
    pricePaise: row.price_paise, // whole paise: ₹499.00 = 49900
    admissionPerSecond: row.admission_per_second, // null = no waiting room
    lobbyMinutes: row.lobby_minutes, // the waiting room opens this many minutes before the sale
    // The lucky draw: lotteryTickets set aside, drawn lotteryDrawMinutes after the sale opens,
    // up to lotteryPerWinner each. lotteryClosedAt = the draw is over (leftovers back on normal sale).
    lotteryPercent: row.lottery_percent,
    lotteryTickets: row.lottery_tickets,
    lotteryDrawMinutes: row.lottery_draw_minutes,
    lotteryPerWinner: row.lottery_per_winner,
    lotteryClosedAt: row.lottery_closed_at,
    createdAt: row.created_at,
  };
}

export async function createEvent(
  { name, totalTickets, saleStartsAt, pricePaise, admissionPerSecond = null, lobbyMinutes = 15, lottery = {} },
  client = pool,
) {
  const { percent = 0, tickets = 0, drawMinutes = 30, perWinner = 2 } = lottery;
  const { rows } = await client.query(
    `INSERT INTO events (name, total_tickets, sale_starts_at, price_paise, admission_per_second, lobby_minutes,
                         lottery_percent, lottery_tickets, lottery_draw_minutes, lottery_per_winner)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING ${COLUMNS}`,
    [name, totalTickets, saleStartsAt, pricePaise, admissionPerSecond, lobbyMinutes, percent, tickets, drawMinutes, perWinner],
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

// Locks the event row until the transaction ends. Payments for the same event then run one
// after another, so "how much has this user bought?" can't change while we decide (Phase 5b).
export async function lockEvent(client, eventId) {
  await client.query('SELECT id FROM events WHERE id = $1 FOR UPDATE', [eventId]);
}

// Takes the next `quantity` ticket numbers for an event, atomically (Postgres row lock).
// The CHECK (tickets_sold <= total_tickets) makes the DATABASE refuse an oversell: if this
// would go past the total, Postgres throws (constraint events_tickets_sold_within_total).
// Returns the numbers, e.g. [9, 10].
export async function takeTicketNumbers(client, eventId, quantity) {
  const { rows } = await client.query(
    'UPDATE events SET tickets_sold = tickets_sold + $2 WHERE id = $1 RETURNING tickets_sold',
    [eventId, quantity],
  );
  const last = rows[0].tickets_sold;
  return Array.from({ length: quantity }, (_, i) => last - quantity + 1 + i);
}

// Tickets that are SOLD for good (paid orders, Phase 2), in total and from the lucky draw's pool.
// Used to rebuild Redis stock.
export async function countSoldTickets(eventId) {
  const { rows } = await pool.query(
    `SELECT count(*)::int AS sold, (count(*) FILTER (WHERE o.pool = 'lottery'))::int AS sold_lottery
       FROM sold_tickets AS s JOIN orders AS o ON o.id = s.order_id
      WHERE s.event_id = $1`,
    [eventId],
  );
  return { sold: rows[0].sold, soldLottery: rows[0].sold_lottery };
}
