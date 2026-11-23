// The landing page: the events on sale, who's signed in, and the API's health.
import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { api } from '../api/client.js'
import { listEvents } from '../api/events.js'
import { useAuth } from '../auth/useAuth.js'

export function HomePage() {
  const { status, user } = useAuth()
  const [events, setEvents] = useState(null)
  const [health, setHealth] = useState(null)
  const [healthError, setHealthError] = useState(null)

  useEffect(() => {
    let active = true
    api('/health').then(
      (result) => active && setHealth(result),
      (err) => active && setHealthError(err.message),
    )
    listEvents().then(
      (result) => active && setEvents(result.events),
      () => active && setEvents([]),
    )
    return () => {
      active = false
    }
  }, [])

  return (
    <section>
      <h1>Flash-Sale Tickets</h1>
      {status === 'signed-in' ? (
        <p>
          Welcome back, <strong>{user.email}</strong>.
        </p>
      ) : status === 'signed-out' ? (
        <p>
          <Link to="/login">Log in</Link> or <Link to="/register">create an account</Link> to hold tickets.
        </p>
      ) : null}

      <h2>Events</h2>
      {events === null && <p className="muted">Loading…</p>}
      {events?.length > 0 && (
        <ul>
          {events.map((event) => (
            <li key={event.id}>
              <Link to={`/events/${event.id}`}>{event.name}</Link> —{' '}
              {event.onSale ? `${event.available} of ${event.totalTickets} left` : 'not on sale yet'}
            </li>
          ))}
        </ul>
      )}
      {events?.length === 0 && (
        // Nothing to show yet: say exactly how to get something to show.
        <div className="muted">
          <p>No events yet.</p>
          {user?.role === 'admin' ? (
            <p>
              Create one in <Link to="/admin/events">Manage events</Link>.
            </p>
          ) : (
            <p>
              An admin can create events. For local testing: run <code>npm run seed:demo</code>, or make yourself an
              admin with <code>npm run set-role -- your@email admin</code> and log in again.
            </p>
          )}
        </div>
      )}

      <p className="status">
        API status:{' '}
        {healthError ? (
          <span className="err">unreachable ({healthError})</span>
        ) : health ? (
          <span className="ok">{health.status}</span>
        ) : (
          'checking…'
        )}
      </p>
    </section>
  )
}
