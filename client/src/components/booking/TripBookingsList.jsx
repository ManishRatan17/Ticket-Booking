// "My bookings": one person's bus or train bookings, newest first, each linking to its page.
import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { bookingApi } from '../../api/bookings.js'
import { errorMessage } from '../../lib/errorMessages.js'
import { formatDate, formatMoney } from '../../lib/format.js'
import { Alert } from '../Alert.jsx'

export function TripBookingsList({ kind }) {
  const [bookings, setBookings] = useState(null)
  const [error, setError] = useState(null)

  useEffect(() => {
    let active = true
    bookingApi(kind)
      .list()
      .then(
        (result) => active && setBookings(result.bookings),
        (err) => active && setError(errorMessage(err)),
      )
    return () => {
      active = false
    }
  }, [kind])

  if (error) return <Alert>{error}</Alert>
  if (!bookings) return <p className="muted">Loading…</p>
  if (bookings.length === 0) {
    return (
      <p className="muted">
        No {kind} bookings yet. <Link to={`/book/${kind}`}>Find a {kind}</Link>.
      </p>
    )
  }
  return (
    <ul className="booking-list">
      {bookings.map((b) => (
        <li key={b.id} className="booking-list__item">
          <Link to={`/book/${kind}/bookings/${b.id}`} className="booking-list__route">
            {b.trip.from} → {b.trip.to}
          </Link>
          <span className="muted">
            {formatDate(b.trip.departsAt)} · {kind === 'bus' ? `${b.seats.length} seat${b.seats.length > 1 ? 's' : ''}` : `${b.classCode}, ${b.travellers.length} traveller${b.travellers.length > 1 ? 's' : ''}`}
            {b.pnr && ` · PNR ${b.pnr}`} · {formatMoney(b.amountPaise)}
          </span>
          <span className={`ticket__status ticket__status--${b.status}`}>{b.status}</span>
          {b.refund && <span className="muted">{b.refund.status === 'refunded' ? 'refunded' : 'refund on its way'}</span>}
        </li>
      ))}
    </ul>
  )
}
