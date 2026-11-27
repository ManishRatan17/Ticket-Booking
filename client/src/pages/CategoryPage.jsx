// /book/:category: where a category card leads. Bookable categories (Train, Bus) list what's on sale,
// each event leading to the real booking flow (hold → checkout → pay). Categories not built yet
// (Movie, Flight) show the full-screen "Coming soon" instead. Opened from the landing page, its data
// arrives with the navigation (loaded during the animation); opened directly, it loads the data itself.
import { useEffect, useState } from 'react'
import { Link, useLocation, useParams } from 'react-router-dom'
import { Alert } from '../components/Alert.jsx'
import { ComingSoon } from '../components/ComingSoon.jsx'
import { findCategory, loadCategory } from '../lib/categories.js'
import { errorMessage } from '../lib/errorMessages.js'
import { NotFoundPage } from './NotFoundPage.jsx'

export function CategoryPage() {
  const { category: key } = useParams()
  const location = useLocation()
  const category = findCategory(key)
  const [data, setData] = useState(location.state?.data ?? null)
  const [error, setError] = useState(null)
  const [attempt, setAttempt] = useState(0)

  useEffect(() => {
    if (!category?.available || data) return undefined
    let active = true
    loadCategory(category.key).then(
      (result) => active && setData(result),
      (err) => active && setError(errorMessage(err)),
    )
    return () => {
      active = false
    }
  }, [category, data, attempt])

  if (!category) return <NotFoundPage />
  if (!category.available) return <ComingSoon category={category} />

  function retry() {
    setError(null)
    setAttempt((a) => a + 1)
  }

  return (
    <section className={`category-page category--${category.key}`}>
      <p>
        <Link to="/">← All categories</Link>
      </p>
      <div className="category-page__header">
        <span className="category-card__icon" aria-hidden="true">
          {category.emoji}
        </span>
        <div>
          <h1>{category.label}</h1>
          <p className="muted">{category.tagline}</p>
        </div>
      </div>

      <p className="muted">Choose what to book.</p>

      {error ? (
        <>
          <Alert>{error}</Alert>
          <button type="button" className="button" onClick={retry}>
            Try again
          </button>
        </>
      ) : !data ? (
        <p className="muted">Loading…</p>
      ) : data.events.length === 0 ? (
        <p>Nothing on sale right now.</p>
      ) : (
        <ul>
          {data.events.map((event) => (
            <li key={event.id}>
              <Link to={`/events/${event.id}`}>{event.name}</Link>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}
