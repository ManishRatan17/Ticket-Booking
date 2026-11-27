// /book/:category: where a category card leads. Train and Bus: the search (from, to, date) and the
// trips found, leading to seats / class, passenger details and payment. Categories not built yet
// (Movie, Flight) show the full-screen "Coming soon". Opened from the landing page, the route
// suggestions arrive with the navigation (loaded during the animation); opened directly, they load here.
import { useEffect, useState } from 'react'
import { Link, useLocation, useParams } from 'react-router-dom'
import { ComingSoon } from '../components/ComingSoon.jsx'
import { TripSearch } from '../components/booking/TripSearch.jsx'
import { findCategory, loadCategory } from '../lib/categories.js'
import { NotFoundPage } from './NotFoundPage.jsx'

export function CategoryPage() {
  const { category: key } = useParams()
  const location = useLocation()
  const category = findCategory(key)
  const [data, setData] = useState(location.state?.data ?? null)

  useEffect(() => {
    if (!category?.available || data) return undefined
    let active = true
    // Only suggestions: if they can't load, the search still works.
    loadCategory(category.key).then(
      (result) => active && setData(result),
      () => active && setData({ routes: [] }),
    )
    return () => {
      active = false
    }
  }, [category, data])

  if (!category) return <NotFoundPage />
  if (!category.available) return <ComingSoon category={category} />

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
      <TripSearch kind={category.key} routes={data?.routes ?? []} />
    </section>
  )
}
