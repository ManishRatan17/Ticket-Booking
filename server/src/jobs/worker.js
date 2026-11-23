// The CONSUMER side: takes jobs from the queue and runs the matching processor.
import { Worker } from 'bullmq';
import { env } from '../config/env.js';
import { QUEUE_NAME, createJobsConnection } from './queue.js';
import { processors } from './processors.js';

export function createWorker({ log = console.log } = {}) {
  const connection = createJobsConnection();
  const worker = new Worker(
    QUEUE_NAME,
    async (job) => {
      const run = processors[job.name];
      if (!run) throw new Error(`No processor for job "${job.name}"`);
      return run(job.data);
    },
    {
      connection,
      prefix: env.jobs.prefix,
      concurrency: 10, // up to 10 jobs at once in this process
    },
  );

  worker.on('completed', (job, result) => {
    // admit-waiting runs every second: only log it when it actually let someone in.
    if (job.name === 'admit-waiting' && !result?.admitted) return;
    log(`[worker] ${job.name} ${job.id} → ${JSON.stringify(result)}`);
  });
  worker.on('failed', (job, err) =>
    log(`[worker] ${job?.name} ${job?.id} failed (attempt ${job?.attemptsMade}/${job?.opts.attempts}): ${err.message}`),
  );
  worker.on('error', (err) => log(`[worker] error: ${err.message}`)); // e.g. Redis down: BullMQ keeps retrying

  // Stop taking jobs, wait for running ones to finish, then close our Redis connection.
  worker.shutdown = async () => {
    await worker.close();
    await connection.quit();
  };
  return worker;
}
