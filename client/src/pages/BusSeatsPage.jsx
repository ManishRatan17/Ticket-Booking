// /book/bus/trips/:id: the bus's seat map. Choose up to 6 free seats, then hold them (10 minutes) and
// go on to the passenger details and payment.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link, useLocation, useNavigate, useParams } from 'react-router-dom'
import { bookingApi } from '../api/bookings.js'
import { useAuth } from '../auth/useAuth.js'
import { Alert } from '../components/Alert.jsx'
import { BookingSteps } from '../components/booking/BookingSteps.jsx'
import { errorMessage } from '../lib/errorMessages.js'
import { formatDate, formatMoney } from '../lib/format.js'
import { duration, seatRows } from '../lib/booking.js'

const MAX_SEATS = 6
const api = bookingApi('bus')

export function BusSeatsPage() {
  const { id } = useParams()
  const navigate = useNavigate()
  const location = useLocation()
  const { status } = useAuth()
  const [trip, setTrip] = useState(null)
  const [chosen, setChosen] = useState([])
  const [error, setError] = useState(null)
  const [busy, setBusy] = useState(false)
  const key = useRef(null) // one Idempotency-Key per set of seats: a retried click can't book twice

  const load = useCallback(() => api.trip(id).then(({ trip: t }) => setTrip(t), (err) => setError(errorMessage(err))), [id])
  useEffect(() => {
    load()
  }, [load])

  const rows = useMemo(() => (trip ? seatRows(trip.seats.map((s) => s.label)) : []), [trip])
  const taken = useMemo(() => new Set(trip?.seats.filter((s) => s.taken).map((s) => s.label)), [trip])

  function toggle(label) {
    setError(null)
    key.current = null
    if (chosen.includes(label)) return setChosen(chosen.filter((s) => s !== label))
    if (chosen.length >= MAX_SEATS) return setError(`At most ${MAX_SEATS} seats per booking.`)
    setChosen([...chosen, label])
  }

  async function hold() {
    key.current ??= crypto.randomUUID()
    setBusy(true)
    setError(null)
    try {
      const { booking } = await api.hold(id, { seats: chosen }, key.current)
      navigate(`/book/bus/bookings/${booking.id}`)
    } catch (err) {
      key.current = null
      setError(errorMessage(err))
      if (err.code === 'SEATS_TAKEN') {
        // Someone was quicker: drop those seats and show the map as it is now.
        const lost = new Set(err.details?.seats ?? [])
        setChosen((c) => c.filter((s) => !lost.has(s)))
        load()
      }
      setBusy(false)
    }
  }

  if (!trip) {
    return (
      <section>
        <Alert>{error}</Alert>
        {!error && <p className="muted">Loading the seat map…</p>}
      </section>
    )
  }

  const seat = (label) => {
    const isTaken = taken.has(label)
    const isChosen = chosen.includes(label)
    return (
      <button
        key={label}
        type="button"
        className={`seat${isTaken ? ' seat--taken' : ''}${isChosen ? ' seat--chosen' : ''}`}
        disabled={isTaken}
        aria-pressed={isChosen}
        aria-label={`Seat ${label}${isTaken ? ', taken' : isChosen ? ', chosen' : ', free'}`}
        onClick={() => toggle(label)}
      >
        {label}
      </button>
    )
  }

  return (
    <section className="booking-page category--bus">
      <p>
        <button type="button" className="button-link" onClick={() => navigate(-1)}>
          ← Back to results
        </button>
      </p>
      <BookingSteps current="seats" kind="bus" />
      <header className="booking-page__header">
        <p className="ticket__kicker">
          {trip.operator} · {trip.busNumber}
        </p>
        <h1>
          {trip.from} → {trip.to}
        </h1>
        <p className="muted">
          {formatDate(trip.departsAt)} · {duration(trip.departsAt, trip.arrivesAt)} · {formatMoney(trip.farePaise)} per seat
        </p>
      </header>

      <div className="seat-layout">
        <div className="seatmap" role="group" aria-label="Seat map">
          <div className="seatmap__front" aria-hidden="true">
            <span>Driver</span>
            <span>Front ▲</span>
          </div>
          {rows.map((r) => (
            <div key={r.row} className="seatmap__row">
              <div className="seatmap__side">{r.left.map(seat)}</div>
              <span className="seatmap__aisle" aria-hidden="true">
                {r.row}
              </span>
              <div className="seatmap__side">{r.right.map(seat)}</div>
            </div>
          ))}
          <div className="seat-legend" aria-hidden="true">
            <span>
              <i className="seat seat--legend" /> Free
            </span>
            <span>
              <i className="seat seat--legend seat--chosen" /> Yours
            </span>
            <span>
              <i className="seat seat--legend seat--taken" /> Taken
            </span>
          </div>
        </div>

        <aside className="panel seat-summary">
          <h2>Your seats</h2>
          {chosen.length === 0 ? (
            <p className="muted">Choose up to {MAX_SEATS} free seats on the map.</p>
          ) : (
            <p>
              <strong>{[...chosen].sort().join(', ')}</strong>
              <br />
              {chosen.length} × {formatMoney(trip.farePaise)} = <strong>{formatMoney(trip.farePaise * chosen.length)}</strong>
            </p>
          )}
          <Alert>{error}</Alert>
          {status === 'signed-in' ? (
            <button type="button" className="button" disabled={busy || chosen.length === 0} onClick={hold}>
              {busy ? 'Holding…' : chosen.length ? `Hold ${chosen.length} seat${chosen.length > 1 ? 's' : ''} for 10 minutes` : 'Choose seats'}
            </button>
          ) : (
            <Link className="button" to="/login" state={{ from: location.pathname }}>
              Log in to book
            </Link>
          )}
          <p className="muted seat-summary__note">{trip.seatsLeft} of {trip.totalSeats} seats free</p>
        </aside>
      </div>
    </section>
  )
}
