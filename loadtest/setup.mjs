// Load test, step 1: create the event and the people (Phase 6). Run from the repo root:
//
//   node --env-file=server/.env loadtest/setup.mjs stampede      10000 300
//   node --env-file=server/.env loadtest/setup.mjs waiting-room  10000 300
//                                                   scenario      people tickets
//
// Writes loadtest/.data/run.json (the event) and loadtest/.data/users.json (each person's id,
// access-token cookie and a fake IP). The data folder is git-ignored: the tokens are real logins.
import { mkdirSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

const server = new URL('../server/', import.meta.url);
const { createEvent } = await import(new URL('src/modules/events/events.service.js', server));
const { createSignedInUsers } = await import(new URL('test-support/users.js', server));
const { closeConnections } = await import(new URL('src/config/connections.js', server));

const [scenario = 'stampede', peopleArg = '10000', ticketsArg = '300'] = process.argv.slice(2);
const people = Number(peopleArg);
const tickets = Number(ticketsArg);
if (!['stampede', 'waiting-room'].includes(scenario)) throw new Error(`unknown scenario ${scenario}`);

const run = `loadtest-${scenario}-${randomUUID().slice(0, 6)}`;
const LEAD_SECONDS = 45; // waiting room: the sale opens this long after setup (time to fill the lobby)

const event = await createEvent({
  name: `${run} (${tickets} tickets, ${people} people)`,
  totalTickets: tickets,
  pricePaise: 49_900,
  ...(scenario === 'stampede'
    ? { saleStartsAt: new Date(Date.now() - 60_000) } // on sale now, NO waiting room: the worst case
    : { saleStartsAt: new Date(Date.now() + LEAD_SECONDS * 1000), admissionPerSecond: 50, lobbyMinutes: 15 }),
});

const started = Date.now();
const users = await createSignedInUsers(people, { prefix: run });
// A different (made-up) IP per person, like real visitors: 10.x.y.z
const ip = (i) => `10.${(i >> 16) & 255}.${(i >> 8) & 255}.${i & 255}`;

mkdirSync(new URL('./.data/', import.meta.url), { recursive: true });
writeFileSync(new URL('./.data/users.json', import.meta.url), JSON.stringify(users.map((u, i) => ({ id: u.id, cookie: u.cookie, ip: ip(i + 1) }))));
writeFileSync(
  new URL('./.data/run.json', import.meta.url),
  JSON.stringify({ run, scenario, eventId: event.id, tickets, people, saleStartsAt: event.saleStartsAt }, null, 2),
);
console.log(`${run}: event ${event.id} (${tickets} tickets), ${people} signed-in people in ${((Date.now() - started) / 1000).toFixed(1)} s`);
await closeConnections();
