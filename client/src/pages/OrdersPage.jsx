// /orders — everything you've ordered, newest first, with ticket numbers for paid orders.
import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { listOrders } from '../api/orders.js'
import { Alert } from '../components/Alert.jsx'
import { errorMessage } from '../lib/errorMessages.js'
import { formatDate, formatMoney } from '../lib/format.js'
import { REFUND_REASON_TEXT } from '../lib/refunds.js'
import { TripBookingsList } from '../components/booking/TripBookingsList.jsx'

const STATUS_TEXT = {
  pending: 'waiting for payment',
  paid: 'paid',
  failed: 'payment failed',
  expired: 'expired (not paid in time)',
  cancelled: 'cancelled (the event was cancelled)',
}

export function OrdersPage() {
  const [orders, setOrders] = useState(null)
  const [error, setError] = useState(null)

  useEffect(() => {
    let active = true
    listOrders().then(
      (result) => active && setOrders(result.orders),
      (err) => active && setError(errorMessage(err)),
    )
    return () => {
      active = false
    }
  }, [])

  return (
    <section>
      <h1>My bookings</h1>
      <h2>🚌 Bus</h2>
      <TripBookingsList kind="bus" />
      <h2>🚆 Train</h2>
      <TripBookingsList kind="train" />
      <h2>🎟 Events</h2>
      <Alert>{error}</Alert>
      {orders === null && !error && <p className="muted">Loading…</p>}
      {orders?.length === 0 && (
        <p className="muted">
          No orders yet. <Link to="/events">Find an event</Link>.
        </p>
      )}
      <ul>
        {orders?.map((order) => (
          <li key={order.id}>
            <strong>{order.eventName}</strong> — {order.quantity} ticket{order.quantity > 1 ? 's' : ''},{' '}
            {formatMoney(order.amountPaise)} — {STATUS_TEXT[order.status] ?? order.status}
            {order.pool === 'lottery' && ' · 🎟 lucky draw'}
            {order.status === 'paid' && <> — ticket{order.ticketNumbers.length > 1 ? 's' : ''} #{order.ticketNumbers.join(', #')}</>}
            {order.status === 'pending' && (
              <>
                {' '}
                — <Link to={`/checkout/${order.id}`}>pay now</Link>
              </>
            )}
            {order.refund && (
              <>
                {' '}
                — <strong>{order.refund.status === 'refunded' ? `refunded ${formatMoney(order.refund.amountPaise)}` : `refund of ${formatMoney(order.refund.amountPaise)} on its way`}</strong>{' '}
                <span className="muted">({REFUND_REASON_TEXT[order.refund.reason] ?? order.refund.reason})</span>
              </>
            )}
            <span className="muted"> · {formatDate(order.createdAt)}</span>
          </li>
        ))}
      </ul>
    </section>
  )
}
