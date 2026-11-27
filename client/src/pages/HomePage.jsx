// The landing page: the four booking categories (each opens with its own full-screen animation),
// the events on sale, who's signed in, and the API's health.
import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { api } from '../api/client.js'
import { listEvents } from '../api/events.js'
import { useAuth } from '../auth/useAuth.js'
import { CategoryTransition } from '../components/transitions/CategoryTransition.jsx'
import { useCategoryTransition } from '../hooks/useCategoryTransition.js'
import { useMinimumLoading } from '../hooks/useMinimumLoading.js'
import { CATEGORIES } from '../lib/categories.js'
import { EventCard } from '../components/EventCard.jsx'

export function HomePage() {
  const { status, user } = useAuth()
  const [events, setEvents] = useState(null)
  const [health, setHealth] = useState(null)
  const [healthError, setHealthError] = useState(null)
  const isLoadingEvents = useMinimumLoading(events === null, 1500)
  const transition = useCategoryTransition()

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
      <div className="landing-hero">
        <p className="landing-eyebrow">Fair, fast, bot-proof ticketing</p>
        <h1>Where are you headed?</h1>
        <p>Trains, buses, movies and flights, with fair queues even when everyone clicks at once.</p>
        {status === 'signed-in' ? (
          <p className="landing-hero__user">
            Welcome back, <strong>{user.email}</strong>.
          </p>
        ) : status === 'signed-out' ? (
          <p className="landing-hero__user">
            <Link to="/login">Log in</Link> or <Link to="/register">create an account</Link> to book.
          </p>
        ) : null}
      </div>

      <div className="category-grid">
        {CATEGORIES.map((category) => (
          <button
            key={category.key}
            type="button"
            className={`category-card category--${category.key}${category.available ? '' : ' category-card--soon'}`}
            onClick={() => transition.start(category)}
            disabled={transition.active !== null}
          >
            {!category.available && <span className="category-card__badge">Coming soon</span>}
            <span className="category-card__icon" aria-hidden="true">
              {category.emoji}
            </span>
            <span className="category-card__label">{category.label}</span>
            <span className="category-card__tagline">{category.tagline}</span>
            <span className="category-card__cta">
              {category.available ? 'Book now' : 'Take a peek'} <span aria-hidden="true">→</span>
            </span>
          </button>
        ))}
      </div>

      {transition.active && (
        <CategoryTransition
          category={transition.active.category}
          phase={transition.active.phase}
          error={transition.active.error}
          onRetry={transition.retry}
          onCancel={transition.cancel}
        />
      )}

      <div className="section-head">
        <h2>On sale now</h2>
        <Link to="/events">All events →</Link>
      </div>
      {isLoadingEvents ? (
        <div className="event-grid" aria-label="Loading events">
          {[1, 2, 3].map((i) => (
            <div key={i} className="skeleton event-card--skeleton" />
          ))}
        </div>
      ) : (
        <>
          {events?.length > 0 && (
            <ul className="event-grid">
              {events.slice(0, 6).map((event) => (
                <EventCard key={event.id} event={event} />
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
        </>
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
