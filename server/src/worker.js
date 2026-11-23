// The WORKER PROCESS: `npm run worker` (and part of `npm run dev`).
//
// It runs separately from the API on purpose (crash isolation): a stuck or crashing job can't
// slow down or take down the API, and API and workers can be restarted and scaled separately.
// With several worker processes, BullMQ still hands each job to exactly ONE of them.
import { env } from './config/env.js';
import { createWorker } from './jobs/worker.js';
import { scheduleSweep, scheduleAdmissions } from './jobs/queue.js';
import { indexAllHolds } from './modules/reservation/holds.js';
import { closeConnections } from './config/connections.js';

const worker = createWorker();
console.log(`[worker] listening for jobs (queue "expirations", prefix "${env.jobs.prefix}")`);

// Safety net, set up at every start (both steps are idempotent):
//  • make sure every existing hold is in the expiry index (holds from before the index existed)
//  • make sure the 60-second sweep is scheduled
try {
  const indexed = await indexAllHolds();
  await scheduleSweep();
  await scheduleAdmissions();
  console.log(`[worker] sweep every 60 s, waiting-room admission every 1 s; ${indexed} existing hold(s) indexed`);
} catch (err) {
  console.error(`[worker] could not set up the sweep: ${err.message}`);
}

// Graceful shutdown: stop taking new jobs, let the running ones FINISH, then close connections.
// (Killing mid-job is survivable — the job comes back and is idempotent — but finishing is nicer.)
async function shutdown(signal) {
  console.log(`[worker] ${signal} received, finishing current jobs…`);
  await worker.shutdown();
  await closeConnections();
  process.exit(0);
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
