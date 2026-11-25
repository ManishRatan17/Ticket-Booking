// Admin → System: the work that happens in the background, without anyone clicking. Is the worker
// alive, how much work is waiting, and what FAILED (with Retry).
import { useCallback, useEffect, useState } from 'react'
import { getJobsOverview, retryJob, withFreshRole } from '../api/admin.js'
import { Alert } from '../components/Alert.jsx'
import { errorMessage } from '../lib/errorMessages.js'
import { timeAgo } from '../lib/format.js'

const STATE_TEXT = {
  delayed: 'delayed (waiting for their time, e.g. holds not expired yet)',
  waiting: 'waiting for a worker',
  active: 'running now',
  completed: 'completed (last 1,000 kept)',
  failed: 'failed every attempt (dead-letter queue)',
}

export function AdminJobsPage() {
  const [data, setData] = useState(null)
  const [error, setError] = useState(null)
  const [notice, setNotice] = useState(null)

  const load = useCallback(async () => {
    try {
      setData(await withFreshRole(getJobsOverview))
      setError(null)
    } catch (err) {
      setError(errorMessage(err))
    }
  }, [])

  // First load, then refresh every 5 seconds while the page is open (state set in callbacks).
  useEffect(() => {
    let active = true
    const refresh = () =>
      withFreshRole(getJobsOverview).then(
        (result) => active && setData(result),
        (err) => active && setError(errorMessage(err)),
      )
    refresh()
    const timer = setInterval(refresh, 5000)
    return () => {
      active = false
      clearInterval(timer)
    }
  }, [])

  async function handleRetry(jobId) {
    setNotice(null)
    try {
      await retryJob(jobId)
      setNotice(`Job ${jobId} was put back in the queue.`)
      await load()
    } catch (err) {
      setError(errorMessage(err))
    }
  }

  if (!data) {
    return (
      <section>
        <h1>System</h1>
        <Alert>{error}</Alert>
        {!error && <p className="muted">Loading…</p>}
      </section>
    )
  }

  return (
    <section>
      <h1>System</h1>
      <Alert>{error}</Alert>
      <Alert kind="success">{notice}</Alert>

      <p className={data.workersOnline > 0 ? 'light light-ok' : 'light light-bad'}>
        {data.workersOnline > 0
          ? `● Background worker running (${data.workersOnline}). Everything below happens automatically.`
          : '● No background worker is running! Expired holds are NOT released, nobody is let in from waiting rooms, and lucky draws don\'t happen. Start it with npm run dev (or npm run worker).'}
      </p>

      <h2>What the background worker does</h2>
      <ul>
        <li>
          <strong>Releases abandoned holds</strong>: when someone holds tickets and doesn't pay within 5 minutes, the
          tickets go back on sale (one delayed job per hold).
        </li>
        <li>
          <strong>Safety sweep</strong> every 60 seconds: catches any expired hold that was missed.
        </li>
        <li>
          <strong>Waiting rooms</strong> every second: lets the next people in line in.
        </li>
        <li>
          <strong>Lucky draws</strong> every 5 seconds: runs draws and their rounds when it's time.
        </li>
      </ul>
      <p className="muted">
        A job that fails is retried with growing pauses; if it fails every time it's kept below (the
        "dead-letter queue") so nothing is silently lost. Fix the cause, then press Retry.
      </p>

      <h2>Jobs by state</h2>
      <ul>
        {Object.entries(STATE_TEXT).map(([state, text]) => (
          <li key={state}>
            <strong>{data.counts[state] ?? 0}</strong> {text}
          </li>
        ))}
      </ul>

      <h2>Schedules</h2>
      {data.schedules.length === 0 ? (
        <p className="muted">None yet (the worker sets up the sweep when it starts).</p>
      ) : (
        <ul>
          {data.schedules.map((s) => (
            <li key={s.name}>
              {s.name} — every {Math.round(s.everyMs / 1000)} s
              {s.nextRunAt && `, next ${timeAgo(s.nextRunAt)}`}
            </li>
          ))}
        </ul>
      )}

      <h2>Failed jobs</h2>
      {data.failedJobs.length === 0 ? (
        <p className="muted">None. 🎉</p>
      ) : (
        <ul>
          {data.failedJobs.map((job) => (
            <li key={job.id}>
              <strong>{job.name}</strong> <code>{job.id}</code> — {job.error} (attempt {job.attempts}/{job.maxAttempts}
              {job.failedAt && `, ${timeAgo(job.failedAt)}`}){' '}
              <button type="button" onClick={() => handleRetry(job.id)}>
                Retry
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}
