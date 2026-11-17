// Demo: what happens when 1,000 buyers try to grab 100 tickets at the same instant?
// Run with: npm run demo:race   (needs `docker compose up -d`)
import {
  setStock,
  getStock,
  holdTicketsNaive,
  holdTicketsDecr,
  holdTickets,
  stockKey,
} from '../src/modules/reservation/stock.js';
import { redis } from '../src/config/redis.js';
import { closeConnections } from '../src/config/connections.js';

const EVENT_ID = 'demo';
const TICKETS = 100;
const BUYERS = 1000;

async function run(name, holdFn) {
  await setStock(EVENT_ID, TICKETS);

  // Start all 1,000 holds WITHOUT waiting for each other, like 1,000 users
  // clicking "Buy" in the same second. Promise.all waits until all are finished.
  const started = performance.now();
  const results = await Promise.all(
    Array.from({ length: BUYERS }, () => holdFn(EVENT_ID, 1)),
  );
  const ms = (performance.now() - started).toFixed(0);

  const winners = results.filter(Boolean).length;
  const left = await getStock(EVENT_ID);
  const oversold = Math.max(0, winners - TICKETS);

  console.log(`\n=== ${name} ===`);
  console.log(`tickets for sale : ${TICKETS}`);
  console.log(`buyers           : ${BUYERS}`);
  console.log(`buyers told "yes": ${winners}`);
  console.log(`stock left       : ${left}`);
  console.log(`time             : ${ms} ms`);
  console.log(oversold > 0 ? `❌ OVERSOLD by ${oversold} tickets` : '✅ no oversell');
}

try {
  await run('Naive check-then-act (broken)', holdTicketsNaive);
  await run('Fix #1: DECRBY + undo', holdTicketsDecr);
  await run('Fix #2: Lua script', holdTickets);
} finally {
  await redis.del(stockKey(EVENT_ID)); // clean up the demo key
  await closeConnections();
}
