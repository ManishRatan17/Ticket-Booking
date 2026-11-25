// Shown on every page while the account is suspended or banned (Phase 5e: bot strikes).
// The wording says "unusual activity", not "you are a bot": detection is never 100 % sure.
import { Link } from 'react-router-dom'

export function RestrictionBanner({ restriction }) {
  if (!restriction) return null
  const until = restriction.until && new Date(restriction.until).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })
  return (
    <div className="alert alert-error" role="alert">
      <strong>Unusual, automated activity was detected on your account.</strong>{' '}
      {restriction.kind === 'banned'
        ? 'Ticket booking is permanently disabled for this account.'
        : `Ticket booking is paused until ${until}.`}{' '}
      You can still sign in and see your orders. If you think this is a mistake,{' '}
      <Link to="/support?kind=appeal">appeal</Link>.
    </div>
  )
}
