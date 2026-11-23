// All events, with tickets left. Anyone can see this page.
import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { listEvents } from '../api/events.js'
import { Alert } from '../components/Alert.jsx'
import { errorMessage } from '../lib/errorMessages.js'
import { clockOffset, formatCountdown, secondsUntil } from '../lib/serverClock.js'

export function EventsPage() {
  const [data, setData] = useState(null) // { events, offset }
  const [error, setError] = useState(null)

  useEffect(() => {
    let active = true
    listEvents().then(
      ({ events, serverTime }) => active && setData({ events, offset: clockOffset(serverTime) }),
      (err) => active && setError(errorMessage(err)),
    )
    return () => {
      active = false
    }
  }, [])

  return (
    <section>
      <h1>Events</h1>
      <Alert>{error}</Alert>
      {!data && !error && <p className="muted">Loading…</p>}
      {data && data.events.length === 0 && <p className="muted">No events yet.</p>}
      {data && data.events.length > 0 && (
        <ul>
          {data.events.map((event) => (
            <li key={event.id}>
              <Link to={`/events/${event.id}`}>{event.name}</Link> —{' '}
              {event.onSale
                ? `${event.available} of ${event.totalTickets} tickets left`
                : `on sale in ${formatCountdown(secondsUntil(event.saleStartsAt, data.offset))}`}
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}
