// From / to / date (and, for trains, a class): the search form of both booking pages. The city boxes
// suggest the upcoming routes (GET /api/{bus|train}/routes); any text can still be typed.
import { useState } from 'react'
import { CLASS_NAMES, tomorrowInIndia } from '../../lib/booking.js'

export function TripSearchForm({ routes = [], initial = {}, withClass = false, busy = false, onSearch }) {
  const [form, setForm] = useState({ from: '', to: '', date: tomorrowInIndia(), classCode: '', ...initial })
  const [error, setError] = useState(null)
  const fromCities = [...new Set(routes.map((r) => r.from))]
  const toCities = [...new Set(routes.filter((r) => !form.from || r.from.toLowerCase() === form.from.trim().toLowerCase()).map((r) => r.to))]
  const set = (name) => (e) => setForm({ ...form, [name]: e.target.value })

  function submit(e) {
    e.preventDefault()
    const from = form.from.trim()
    const to = form.to.trim()
    if (from.length < 2 || to.length < 2) return setError('Enter where you leave from and where you are going.')
    if (from.toLowerCase() === to.toLowerCase()) return setError('From and to must be different places.')
    if (!form.date) return setError('Choose a travel date.')
    setError(null)
    onSearch({ from, to, date: form.date, classCode: form.classCode || undefined })
  }

  function swap() {
    setForm({ ...form, from: form.to, to: form.from })
  }

  return (
    <form className="trip-search" onSubmit={submit} noValidate>
      <div className="trip-search__fields">
        <div className="field">
          <label htmlFor="from">From</label>
          <input id="from" list="from-cities" value={form.from} onChange={set('from')} autoComplete="off" placeholder="City" />
          <datalist id="from-cities">
            {fromCities.map((c) => (
              <option key={c} value={c} />
            ))}
          </datalist>
        </div>
        <button type="button" className="trip-search__swap" onClick={swap} aria-label="Swap from and to">
          ⇄
        </button>
        <div className="field">
          <label htmlFor="to">To</label>
          <input id="to" list="to-cities" value={form.to} onChange={set('to')} autoComplete="off" placeholder="City" />
          <datalist id="to-cities">
            {toCities.map((c) => (
              <option key={c} value={c} />
            ))}
          </datalist>
        </div>
        <div className="field">
          <label htmlFor="date">Travel date</label>
          <input id="date" type="date" value={form.date} onChange={set('date')} />
        </div>
        {withClass && (
          <div className="field">
            <label htmlFor="classCode">Class</label>
            <select id="classCode" value={form.classCode} onChange={set('classCode')}>
              <option value="">Any class</option>
              {Object.entries(CLASS_NAMES).map(([code, name]) => (
                <option key={code} value={code}>
                  {code} · {name}
                </option>
              ))}
            </select>
          </div>
        )}
      </div>
      {error && <p className="field-error">{error}</p>}
      <button type="submit" className="button trip-search__submit" disabled={busy}>
        {busy ? 'Searching…' : 'Search'}
      </button>
      {routes.length > 0 && (
        <p className="muted trip-search__hint">
          Popular:{' '}
          {routes.slice(0, 4).map((r, i) => (
            <span key={`${r.from}-${r.to}`}>
              {i > 0 && ' · '}
              <button type="button" className="button-link" onClick={() => setForm({ ...form, from: r.from, to: r.to })}>
                {r.from} → {r.to}
              </button>
            </span>
          ))}
        </p>
      )}
    </form>
  )
}
