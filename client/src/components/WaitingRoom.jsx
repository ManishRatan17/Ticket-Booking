// What you see while you wait for your turn.
import { formatCountdown } from '../lib/serverClock.js'
import { TurnstileWidget } from './TurnstileWidget.jsx'

// human = useHumanCheck() from the page: joining needs the "are you a person?" check (Phase 5d).
// lobbyOpensIn = seconds until the waiting room opens (0 = open).
export function WaitingRoom({ status, onJoin, saleOpensIn, lobbyOpensIn, human }) {
  if (!status) return <p className="muted">Checking the waiting room…</p>

  // Too early: the waiting room opens a few minutes before the sale (the "lobby window").
  if (status.status === 'not_in_queue' && lobbyOpensIn > 0) {
    return (
      <div className="panel">
        <p>
          The waiting room opens in <strong>{formatCountdown(lobbyOpensIn)}</strong> (at{' '}
          {new Date(status.lobbyOpensAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}).
        </p>
        <p className="muted">Come back then: joining any time while it's open gives you the same chance.</p>
      </div>
    )
  }

  if (status.status === 'not_in_queue') {
    return (
      <div className="panel">
        <p>
          This sale has a <strong>waiting room</strong>: people are let in a few at a time, in the order they
          joined.
        </p>
        {human.siteKey && <TurnstileWidget key={human.round} siteKey={human.siteKey} onToken={human.setToken} />}
        <button type="button" onClick={onJoin} disabled={!human.ready}>
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
