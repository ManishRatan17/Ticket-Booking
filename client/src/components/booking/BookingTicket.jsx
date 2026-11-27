// A bus / train booking as a ticket: route, times, seats or berths with passengers, PNR, price,
// status, and its refund when there is one.
import { formatDate, formatMoney } from '../../lib/format.js'
import { BOOKING_STATUS_TEXT, CLASS_NAMES, duration } from '../../lib/booking.js'
import { REFUND_REASON_TEXT } from '../../lib/refunds.js'

export function BookingTicket({ kind, booking }) {
  const { trip } = booking
  const places = kind === 'bus' ? booking.seats.map((s) => ({ key: s.label, label: `Seat ${s.label}`, passenger: s.passenger })) : booking.travellers.map((t, i) => ({ key: t.berth, label: `Berth ${t.berth}`, passenger: t.passenger, index: i }))
  return (
    <article className={`ticket ticket--${booking.status}`}>
      <header className="ticket__header">
        <div>
          <p className="ticket__kicker">{kind === 'bus' ? `${trip.operator} · ${trip.busNumber}` : `${trip.trainNumber} · ${trip.trainName}`}</p>
          <h2 className="ticket__route">
            {trip.from} <span aria-hidden="true">→</span> {trip.to}
          </h2>
        </div>
        <span className={`ticket__status ticket__status--${booking.status}`}>{booking.status}</span>
      </header>
      <dl className="ticket__facts">
        <div>
          <dt>Departs</dt>
          <dd>{formatDate(trip.departsAt)}</dd>
        </div>
        <div>
          <dt>Arrives</dt>
          <dd>{formatDate(trip.arrivesAt)}</dd>
        </div>
        <div>
          <dt>Journey</dt>
          <dd>{duration(trip.departsAt, trip.arrivesAt)}</dd>
        </div>
        {kind === 'train' && (
          <div>
            <dt>Class</dt>
            <dd>
              {booking.classCode} · {CLASS_NAMES[booking.classCode]}
            </dd>
          </div>
        )}
        {booking.pnr && (
          <div>
            <dt>PNR</dt>
            <dd className="ticket__pnr">{booking.pnr}</dd>
          </div>
        )}
        <div>
          <dt>Total</dt>
          <dd>{formatMoney(booking.amountPaise)}</dd>
        </div>
      </dl>
      <ul className="ticket__places">
        {places.map((p) => (
          <li key={p.key}>
            <strong>{p.label}</strong>
            <span className="muted">{p.passenger ? `${p.passenger.name}, ${p.passenger.age}` : 'details not given yet'}</span>
          </li>
        ))}
      </ul>
      <p className="muted ticket__note">
        Booking {booking.id} · {BOOKING_STATUS_TEXT[booking.status]}
        {booking.payment?.paid && ` · paid${booking.payment.provider === 'fake' ? ' (development payment)' : ''}`}
      </p>
      {booking.refund && (
        <p className="ticket__refund">
          {booking.refund.status === 'refunded' ? 'Refunded' : 'Refund on its way:'} {formatMoney(booking.refund.amountPaise)} ({REFUND_REASON_TEXT[booking.refund.reason] ?? booking.refund.reason})
        </p>
      )}
    </article>
  )
}
