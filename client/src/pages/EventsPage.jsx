// All events, as cards. Anyone can see this page.
import { useEffect, useState } from 'react'
import { listEvents } from '../api/events.js'
import { Alert } from '../components/Alert.jsx'
import { EventCard } from '../components/EventCard.jsx'
import { errorMessage } from '../lib/errorMessages.js'
import { clockOffset } from '../lib/serverClock.js'

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
      <header className="page-header">
        <div>
          <h1>Events</h1>
          <p>Concerts, shows and more. Fair queues and a lucky draw for the busiest sales.</p>
        </div>
      </header>
      <Alert>{error}</Alert>
      {!data && !error && (
        <div className="event-grid" aria-label="Loading events">
          {[1, 2, 3].map((i) => (
            <div key={i} className="skeleton event-card--skeleton" />
          ))}
        </div>
      )}
      {data && data.events.length === 0 && (
        <div className="empty-state">
          <span className="empty-state__icon" aria-hidden="true">
            🎟
          </span>
          <strong>No events yet</strong>
          <p>New sales appear here as soon as they're announced.</p>
        </div>
      )}
      {data && data.events.length > 0 && (
        <ul className="event-grid">
          {data.events.map((event) => (
            <EventCard key={event.id} event={event} offset={data.offset} />
          ))}
        </ul>
      )}
    </section>
  )
}
