// /book/bus/bookings/:id and /book/train/bookings/:id: one page for both. While the booking is held:
// the countdown, the passenger details, then payment. Afterwards: the ticket (and Cancel).
import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { bookingApi } from '../api/bookings.js'
import { useAuth } from '../auth/useAuth.js'
import { Alert } from '../components/Alert.jsx'
import { BookingSteps } from '../components/booking/BookingSteps.jsx'
import { BookingTicket } from '../components/booking/BookingTicket.jsx'
import { PassengerForm } from '../components/booking/PassengerForm.jsx'
import { PaymentPanel } from '../components/booking/PaymentPanel.jsx'
import { useCountdown } from '../hooks/useCountdown.js'
import { errorMessage } from '../lib/errorMessages.js'
import { clockOffset, formatCountdown } from '../lib/serverClock.js'
import { NotFoundPage } from './NotFoundPage.jsx'

const KINDS = ['bus', 'train']

export function BookingPage() {
  const { kind, id } = useParams()
  return KINDS.includes(kind) ? <Booking key={`${kind}-${id}`} kind={kind} id={id} /> : <NotFoundPage />
}

function Booking({ kind, id }) {
  const api = useMemo(() => bookingApi(kind), [kind])
  const { user } = useAuth()
  const [page, setPage] = useState(null) // { booking, offset }
  const [error, setError] = useState(null)
  const [notice, setNotice] = useState(null)
  const [editing, setEditing] = useState(false)
  const [busy, setBusy] = useState(false)

  const reload = useCallback(
    () =>
      api.get(id).then(
        ({ booking, serverTime }) => setPage({ booking, offset: clockOffset(serverTime) }),
        (err) => setError(errorMessage(err)),
      ),
    [api, id],
  )
  useEffect(() => {
    reload()
  }, [reload])

  const booking = page?.booking
  const held = booking?.status === 'held'
  // When the hold runs out, ask the server what happened (it may have been paid at the last second).
  const secondsLeft = useCountdown(held ? booking.heldUntil : null, page?.offset ?? 0, reload)

  async function saveDetails(details) {
    setBusy(true)
    setError(null)
    try {
      // A bus names each passenger's seat; a train's travellers follow the berth order.
      const body =
        kind === 'bus' ? { ...details, passengers: details.passengers.map((p, i) => ({ seat: page.booking.seats[i].label, ...p })) } : details
      const { booking: saved } = await api.confirm(id, body)
      setPage((p) => ({ ...p, booking: saved }))
      setEditing(false)
    } catch (err) {
      setError(errorMessage(err))
    } finally {
      setBusy(false)
    }
  }

  async function cancel() {
    const paid = booking.payment?.paid
    const sure = window.confirm(
      held ? 'Release these seats? They go back on sale.' : `Cancel this booking?${paid ? ' The amount you paid will be refunded.' : ''} This can't be undone.`,
    )
    if (!sure) return
    setBusy(true)
    setError(null)
    try {
      const { booking: cancelled } = await api.cancel(id)
      setPage((p) => ({ ...p, booking: cancelled }))
      setNotice(cancelled.refund ? 'Cancelled. Your refund is on its way; we have emailed you.' : 'Cancelled.')
    } catch (err) {
      setError(errorMessage(err))
    } finally {
      setBusy(false)
    }
  }

  if (!booking) {
    return (
      <section>
        <Alert>{error}</Alert>
        {!error && <p className="muted">Loading your booking…</p>}
      </section>
    )
  }

  const slots =
    kind === 'bus'
      ? booking.seats.map((s) => ({ key: s.label, label: `Seat ${s.label}`, passenger: s.passenger }))
      : booking.travellers.map((t, i) => ({ key: t.berth, label: `Traveller ${i + 1} · berth ${t.berth}`, passenger: t.passenger }))
  const askDetails = held && (!booking.passengersGiven || editing)
  const step = booking.status === 'confirmed' ? 'done' : askDetails ? 'details' : held ? 'pay' : 'done'
  const departed = new Date(booking.trip.departsAt) <= new Date()

  return (
    <section className={`booking-page category--${kind}`}>
      <BookingSteps current={step} kind={kind} />
      <Alert>{error}</Alert>
      <Alert kind="success">{notice}</Alert>

      {held && (
        <p className={`hold-timer${secondsLeft <= 60 ? ' hold-timer--urgent' : ''}`} role="timer">
          {kind === 'bus' ? 'Seats' : 'Berths'} held for <strong>{formatCountdown(secondsLeft)}</strong>
        </p>
      )}

      {askDetails ? (
        <div className="booking-page__grid">
          <div className="panel">
            <h2>{kind === 'bus' ? 'Passenger details' : 'Traveller details'}</h2>
            <PassengerForm
              slots={slots}
              initial={slots.map((s) => s.passenger ?? {})}
              initialPhone={booking.contactPhone}
              busy={busy}
              submitLabel={booking.payment?.required ? 'Continue to payment' : 'Confirm booking'}
              onSubmit={saveDetails}
            />
          </div>
          <BookingTicket kind={kind} booking={booking} />
        </div>
      ) : held ? (
        <div className="booking-page__grid">
          <div className="panel">
            <h2>Payment</h2>
            <PaymentPanel
              api={api}
              booking={booking}
              email={user?.email}
              onSettled={(latest) => setPage((p) => ({ ...p, booking: latest }))}
            />
            <p className="muted">
              <button type="button" className="button-link" onClick={() => setEditing(true)}>
                Change the {kind === 'bus' ? 'passenger' : 'traveller'} details
              </button>
            </p>
          </div>
          <BookingTicket kind={kind} booking={booking} />
        </div>
      ) : (
        <>
          {booking.status === 'confirmed' && (
            <div className="booking-done">
              <span className="booking-done__icon" aria-hidden="true">
                ✓
              </span>
              <div>
                <h1>You're booked!</h1>
                <p className="muted">{kind === 'train' ? `Your PNR is ${booking.pnr}. ` : ''}We've emailed your ticket.</p>
              </div>
            </div>
          )}
          {booking.status === 'expired' && <Alert>Your hold ran out before payment, so the {kind === 'bus' ? 'seats' : 'berths'} went back on sale.</Alert>}
          <BookingTicket kind={kind} booking={booking} />
        </>
      )}

      <p className="booking-page__links">
        <Link to="/orders">My bookings</Link> · <Link to={`/book/${kind}`}>Book another {kind}</Link>
        {(held || booking.status === 'confirmed') && !departed && (
          <>
            {' · '}
            <button type="button" className="button-link button-link--danger" disabled={busy} onClick={cancel}>
              {held ? 'Release seats' : 'Cancel booking'}
            </button>
          </>
        )}
      </p>
    </section>
  )
}
