// Admin view of the background jobs (Phase 3): how many jobs are where, which workers are
// alive, when the sweep runs next, and the FAILED jobs — the dead-letter queue — with Retry.
import { AppError } from '../../lib/errors.js';
import { getQueue } from '../../jobs/queue.js';

const STATES = ['waiting', 'delayed', 'active', 'completed', 'failed'];

export async function getJobsOverview() {
  const queue = getQueue();
  const [counts, failed, workers, schedulers] = await Promise.all([
    queue.getJobCounts(...STATES),
    queue.getFailed(0, 49), // the 50 most recent failures
    queue.getWorkers(), // worker processes currently connected to this queue
    queue.getJobSchedulers(),
  ]);

  return {
    counts,
    workersOnline: workers.length,
    schedules: schedulers.map((s) => ({ name: s.key, everyMs: Number(s.every), nextRunAt: s.next ? new Date(s.next) : null })),
    failedJobs: failed.filter(Boolean).map((job) => ({
      id: job.id,
      name: job.name,
      data: job.data,
      error: job.failedReason,
      attempts: job.attemptsMade,
      maxAttempts: job.opts.attempts ?? 1,
      createdAt: new Date(job.timestamp),
      failedAt: job.finishedOn ? new Date(job.finishedOn) : null,
    })),
  };
}

// Puts a failed job back in the queue for one more run (after someone fixed the cause).
// Safe because every job is idempotent.
export async function retryFailedJob(jobId) {
  const job = await getQueue().getJob(jobId);
  if (!job) throw new AppError(404, 'JOB_NOT_FOUND', 'No job with this id');
  if (!(await job.isFailed())) throw new AppError(409, 'JOB_NOT_FAILED', 'Only failed jobs can be retried');
  await job.retry();
}
