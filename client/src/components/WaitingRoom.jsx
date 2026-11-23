// What you see while you wait for your turn.
import { formatCountdown } from '../lib/serverClock.js'

export function WaitingRoom({ status, onJoin, saleOpensIn }) {
  if (!status) return <p className="muted">Checking the waiting room…</p>

  if (status.status === 'not_in_queue') {
    return (
      <div className="panel">
        <p>
          This sale has a <strong>waiting room</strong>: people are let in a few at a time, in the order they
          joined.
        </p>
        <button type="button" onClick={onJoin}>
          Join the queue
        </button>
      </div>
    )
  }

  // 'waiting' ('admitted' is handled by the event page: it shows the hold form instead)
  return (
    <div className="panel" aria-live="polite">
      <p>
        You're <strong>#{status.position.toLocaleString()}</strong> of {status.total.toLocaleString()} in line.
      </p>
      {saleOpensIn > 0 && <p>The sale opens in {formatCountdown(saleOpensIn)} — your place is saved.</p>}
      {status.estimatedWaitSeconds != null && (
        <p className="muted">About {formatCountdown(status.estimatedWaitSeconds)} to go.</p>
      )}
      <p className="muted">Keep this page open: it updates by itself. Reloading or another tab keeps your place.</p>
    </div>
  )
}
