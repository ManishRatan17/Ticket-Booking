// The search on /book/bus and /book/train: the form, then the trips found. The search is kept in the
// URL (?from=…&to=…&date=…&class=…), so the back button and a shared link show the same results.
import { useMemo, useRef, useState, useEffect } from 'react'
import { Link, useLocation, useNavigate, useSearchParams } from 'react-router-dom'
import { bookingApi } from '../../api/bookings.js'
import { useAuth } from '../../auth/useAuth.js'
import { errorMessage } from '../../lib/errorMessages.js'
import { formatMoney } from '../../lib/format.js'
import { CLASS_NAMES, duration, timeInIndia } from '../../lib/booking.js'
import { Alert } from '../Alert.jsx'
import { TripSearchForm } from './TripSearchForm.jsx'

export function TripSearch({ kind, routes }) {
  const api = useMemo(() => bookingApi(kind), [kind])
  const [params, setParams] = useSearchParams()
  const from = params.get('from') ?? ''
  const to = params.get('to') ?? ''
  const date = params.get('date') ?? ''
  const classCode = params.get('class') ?? ''
  const searched = Boolean(from && to && date)
  const key = [from, to, date, classCode].join('|')
  const [result, setResult] = useState(null) // { key, trips } | { key, error }

  useEffect(() => {
    if (!searched) return undefined
    let active = true
    api.search({ from, to, date, classCode }).then(
      ({ trips }) => active && setResult({ key, trips }),
      (err) => active && setResult({ key, error: errorMessage(err) }),
    )
    return () => {
      active = false
    }
  }, [api, searched, from, to, date, classCode, key])

  const loading = searched && result?.key !== key
  const search = (q) => setParams({ from: q.from, to: q.to, date: q.date, ...(q.classCode && { class: q.classCode }) })

  return (
    <div className="trip-search-section">
      <TripSearchForm key={key} routes={routes} initial={searched ? { from, to, date, classCode } : {}} withClass={kind === 'train'} busy={loading} onSearch={search} />
      {searched && (
        <section className="trip-results" aria-live="polite">
          {loading ? (
            <p className="muted">Looking for {kind === 'bus' ? 'buses' : 'trains'}…</p>
          ) : result.error ? (
            <Alert>{result.error}</Alert>
          ) : result.trips.length === 0 ? (
            <div className="panel">
              <p>
                No {kind === 'bus' ? 'buses' : 'trains'} from <strong>{from}</strong> to <strong>{to}</strong> on {date}.
              </p>
              <p className="muted">Try another date, or one of the popular routes above.</p>
            </div>
          ) : (
            <>
              <h2 className="trip-results__title">
                {result.trips.length} {kind === 'bus' ? 'bus' : 'train'}
                {result.trips.length > 1 && (kind === 'bus' ? 'es' : 's')} · {from} → {to}
              </h2>
              <ul className="trip-list">
                {result.trips.map((trip) => (kind === 'bus' ? <BusTripCard key={trip.id} trip={trip} /> : <TrainTripCard key={trip.id} trip={trip} api={api} />))}
              </ul>
            </>
          )}
        </section>
      )}
    </div>
  )
}

function TripTimes({ trip }) {
  return (
    <div className="trip-card__times">
      <strong>{timeInIndia(trip.departsAt)}</strong>
      <span className="trip-card__line" aria-hidden="true">
        {duration(trip.departsAt, trip.arrivesAt)}
      </span>
      <strong>{timeInIndia(trip.arrivesAt)}</strong>
    </div>
  )
}

function BusTripCard({ trip }) {
  return (
    <li className="trip-card">
      <div className="trip-card__who">
        <strong>{trip.operator}</strong>
        <span className="muted">{trip.busNumber}</span>
      </div>
      <TripTimes trip={trip} />
      <div className="trip-card__price">
        <strong>{formatMoney(trip.farePaise)}</strong>
        <span className={trip.seatsLeft > 0 ? 'muted' : 'trip-card__full'}>{trip.seatsLeft > 0 ? `${trip.seatsLeft} seats left` : 'Full'}</span>
      </div>
      {trip.seatsLeft > 0 ? (
        <Link className="button button-small trip-card__action" to={`/book/bus/trips/${trip.id}`}>
          Choose seats
        </Link>
      ) : (
        <span className="button button-small button-secondary trip-card__action" aria-disabled="true">
          Full
        </span>
      )}
    </li>
  )
}

function TrainTripCard({ trip, api }) {
  const { status } = useAuth()
  const navigate = useNavigate()
  const location = useLocation()
  const [travellers, setTravellers] = useState({}) // class → how many
  const [busy, setBusy] = useState(null)
  const [error, setError] = useState(null)
  const keys = useRef({}) // one Idempotency-Key per attempt: a retried click can't book twice

  async function book(cls) {
    const count = travellers[cls.code] ?? 1
    const attempt = `${cls.code}:${count}`
    keys.current[attempt] ??= crypto.randomUUID()
    setBusy(cls.code)
    setError(null)
    try {
      const { booking } = await api.hold(trip.id, { classCode: cls.code, travellers: count }, keys.current[attempt])
      navigate(`/book/train/bookings/${booking.id}`)
    } catch (err) {
      delete keys.current[attempt] // the next click is a new attempt
      setError(errorMessage(err))
      setBusy(null)
    }
  }

  return (
    <li className="trip-card trip-card--train">
      <div className="trip-card__who">
        <strong>
          {trip.trainNumber} · {trip.trainName}
        </strong>
        <span className="muted">
          {trip.from} → {trip.to}
        </span>
      </div>
      <TripTimes trip={trip} />
      <ul className="class-list">
        {trip.classes.map((cls) => (
          <li key={cls.code} className="class-row">
            <span className="class-row__name">
              <strong>{cls.code}</strong> <span className="muted">{CLASS_NAMES[cls.code]}</span>
            </span>
            <span className="class-row__fare">{formatMoney(cls.farePaise)}</span>
            <span className={cls.available > 0 ? 'class-row__left' : 'trip-card__full'}>{cls.available > 0 ? `${cls.available} left` : 'Full'}</span>
            {cls.available > 0 &&
              (status === 'signed-in' ? (
                <span className="class-row__book">
                  <label className="visually-hidden" htmlFor={`t${trip.id}-${cls.code}`}>
                    Travellers in {cls.code}
                  </label>
                  <select id={`t${trip.id}-${cls.code}`} value={travellers[cls.code] ?? 1} onChange={(e) => setTravellers({ ...travellers, [cls.code]: Number(e.target.value) })}>
                    {Array.from({ length: Math.min(6, cls.available) }, (_, i) => i + 1).map((k) => (
                      <option key={k} value={k}>
                        {k} {k > 1 ? 'travellers' : 'traveller'}
                      </option>
                    ))}
                  </select>
                  <button type="button" className="button button-small" disabled={busy !== null} onClick={() => book(cls)}>
                    {busy === cls.code ? 'Holding…' : 'Book'}
                  </button>
                </span>
              ) : (
                <Link className="button button-small button-secondary class-row__book" to="/login" state={{ from: `${location.pathname}${location.search}` }}>
                  Log in to book
                </Link>
              ))}
          </li>
        ))}
      </ul>
      <Alert>{error}</Alert>
    </li>
  )
}
