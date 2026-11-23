// Creates a few demo events so the ticket pages have something to show:
//
//   npm run seed:demo
//
// Safe to run again: events that already exist (same name) are skipped.
// Uses the same service as the admin API, so stock is loaded into Redis too.
import { pool } from '../src/config/db.js';
import { closeConnections } from '../src/config/connections.js';
import { createEvent } from '../src/modules/events/events.service.js';

const MINUTE = 60_000;
const DEMO_EVENTS = [
  { name: 'Demo: Indie Night', totalTickets: 200, startsInMs: -MINUTE }, // on sale now
  { name: 'Demo: Almost Sold Out', totalTickets: 5, startsInMs: -MINUTE }, // try selling out
  { name: 'Demo: Big Festival', totalTickets: 1000, startsInMs: 10 * MINUTE }, // watch the countdown
];

try {
  for (const demo of DEMO_EVENTS) {
    const { rowCount } = await pool.query('SELECT 1 FROM events WHERE name = $1', [demo.name]);
    if (rowCount > 0) {
      console.log(`skipped  ${demo.name} (already exists)`);
      continue;
    }
    const event = await createEvent({
      name: demo.name,
      totalTickets: demo.totalTickets,
      saleStartsAt: new Date(Date.now() + demo.startsInMs),
    });
    console.log(`created  ${event.name} — id ${event.id}, ${event.totalTickets} tickets`);
  }
} catch (err) {
  console.error(err.message);
  process.exitCode = 1;
} finally {
  await closeConnections();
}
