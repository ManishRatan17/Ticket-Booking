// Load test, step 3: CHECK the result in PostgreSQL and Redis (Phase 6). Run from the repo root:
//
//   node --env-file=server/.env loadtest/verify.mjs
//
// "No errors in k6" isn't enough: this proves, from the data itself, that nothing was oversold.
import { readFileSync, writeFileSync } from 'node:fs';

const server = new URL('../server/', import.meta.url);
const { pool } = await import(new URL('src/config/db.js', server));
const { redis } = await import(new URL('src/config/redis.js', server));
const { closeConnections } = await import(new URL('src/config/connections.js', server));
const { stockKey } = await import(new URL('src/modules/reservation/stock.js', server));

const run = JSON.parse(readFileSync(new URL('./.data/run.json', import.meta.url), 'utf8'));
const id = run.eventId;
const one = async (sql, params = [id]) => (await pool.query(sql, params)).rows[0];

// Let late payments (the fake provider calls back ~1 s later) settle first.
await new Promise((r) => setTimeout(r, 3000));

const event = await one('SELECT total_tickets, tickets_sold FROM events WHERE id = $1');
const sold = await one(
  'SELECT count(*)::int AS n, count(DISTINCT ticket_number)::int AS distinct_numbers, min(ticket_number) AS min, max(ticket_number) AS max FROM sold_tickets WHERE event_id = $1',
);
const orders = await one(
  `SELECT count(*) FILTER (WHERE status = 'paid')::int AS paid_orders,
          COALESCE(sum(quantity) FILTER (WHERE status = 'paid'), 0)::int AS paid_tickets,
          count(*) FILTER (WHERE status = 'pending')::int AS pending,
          count(*) FILTER (WHERE status = 'failed')::int AS failed
     FROM orders WHERE event_id = $1`,
);
const perUser = await one(
  `SELECT COALESCE(max(t), 0)::int AS max_per_person FROM
     (SELECT sum(quantity) AS t FROM orders WHERE event_id = $1 AND status = 'paid' GROUP BY user_id) AS x`,
);

// Redis: what's still on sale, and what's held right now.
const stock = Number(await redis.get(stockKey(id)));
let held = 0;
let holds = 0;
for await (const batch of redis.scanStream({ match: 'hold:*', count: 1000 })) {
  for (const key of batch) {
    const [eventId, quantity] = await redis.hmget(key, 'eventId', 'quantity');
    if (eventId === String(id)) {
      held += Number(quantity);
      holds += 1;
    }
  }
}

const checks = [
  ['never more sold than exist (tickets_sold ≤ total)', event.tickets_sold <= event.total_tickets],
  ['every sold ticket has its own number (no duplicates)', sold.n === sold.distinct_numbers],
  ['sold tickets = the event\'s counter', sold.n === event.tickets_sold],
  ['sold tickets = tickets in paid orders', sold.n === orders.paid_tickets],
  ['ticket numbers within 1…total', sold.n === 0 || (sold.min >= 1 && sold.max <= event.total_tickets)],
  ['nobody over the 4-ticket limit', perUser.max_per_person <= 4],
  ['Redis: on sale + held + sold = total (no ticket lost or created)', stock + held + sold.n === event.total_tickets],
];

const result = {
  run: run.run,
  scenario: run.scenario,
  total: event.total_tickets,
  sold: sold.n,
  held,
  holds,
  onSale: stock,
  paidOrders: orders.paid_orders,
  pendingOrders: orders.pending,
  failedOrders: orders.failed,
  maxPerPerson: perUser.max_per_person,
  checks: Object.fromEntries(checks),
};
writeFileSync(new URL(`./.data/verify-${run.scenario}.json`, import.meta.url), JSON.stringify(result, null, 2));

console.log(`\n${run.run}: ${event.total_tickets} tickets → sold ${sold.n}, held ${held} (${holds} holds), still on sale ${stock}`);
console.log(`orders: ${orders.paid_orders} paid, ${orders.pending} pending, ${orders.failed} failed; most tickets one person bought: ${perUser.max_per_person}`);
for (const [name, ok] of checks) console.log(`${ok ? '✅' : '❌'} ${name}`);
process.exitCode = checks.every(([, ok]) => ok) ? 0 : 1;
await closeConnections();
