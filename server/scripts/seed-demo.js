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
  { name: 'Demo: Indie Night', totalTickets: 200, startsInMs: -MINUTE, pricePaise: 49_900 }, // ₹499, on sale now
  { name: 'Demo: Almost Sold Out', totalTickets: 5, startsInMs: -MINUTE, pricePaise: 99_900 }, // try selling out
  // A waiting room letting 2 people in per second: join before the sale opens and watch your place.
  { name: 'Demo: Big Festival', totalTickets: 1000, startsInMs: 10 * MINUTE, pricePaise: 149_900, admissionPerSecond: 2 },
];

try {
  for (const demo of DEMO_EVENTS) {
    const { rowCount } = await pool.query('SELECT 1 FROM events WHERE name = $1', [demo.name]);
    if (rowCount > 0) {
      // Demo events seeded before prices existed got price 0: give them their price.
      await pool.query('UPDATE events SET price_paise = $2 WHERE name = $1 AND price_paise = 0', [
        demo.name,
        demo.pricePaise,
      ]);
      // …and the demo waiting room, if it was seeded before waiting rooms existed.
      if (demo.admissionPerSecond) {
        await pool.query('UPDATE events SET admission_per_second = $2 WHERE name = $1 AND admission_per_second IS NULL', [
          demo.name,
          demo.admissionPerSecond,
        ]);
      }
      console.log(`skipped  ${demo.name} (already exists)`);
      continue;
    }
    const event = await createEvent({
      name: demo.name,
      totalTickets: demo.totalTickets,
      saleStartsAt: new Date(Date.now() + demo.startsInMs),
      pricePaise: demo.pricePaise,
      admissionPerSecond: demo.admissionPerSecond ?? null,
    });
    console.log(`created  ${event.name} — id ${event.id}, ${event.totalTickets} tickets`);
  }
} catch (err) {
  console.error(err.message);
  process.exitCode = 1;
} finally {
  await closeConnections();
}
