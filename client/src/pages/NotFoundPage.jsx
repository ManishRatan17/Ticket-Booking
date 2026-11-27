import { Link } from 'react-router-dom'

export function NotFoundPage() {
  return (
    <section className="not-found">
      <div className="empty-state">
        <span className="not-found__code" aria-hidden="true">
          404
        </span>
        <strong>This page doesn't exist</strong>
        <p>The link may be old, or the address mistyped.</p>
        <p className="not-found__actions">
          <Link to="/" className="button">
            Go to the home page
          </Link>
          <Link to="/events" className="button button-secondary">
            Browse events
          </Link>
        </p>
      </div>
    </section>
  )
}
