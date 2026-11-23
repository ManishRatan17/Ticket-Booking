// /orders — everything you've ordered, newest first, with ticket numbers for paid orders.
import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { listOrders } from '../api/orders.js'
import { Alert } from '../components/Alert.jsx'
import { errorMessage } from '../lib/errorMessages.js'
import { formatDate, formatMoney } from '../lib/format.js'

const STATUS_TEXT = {
  pending: 'waiting for payment',
  paid: 'paid',
  failed: 'payment failed',
  expired: 'expired (not paid in time)',
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
      <h1>My orders</h1>
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
            {order.status === 'paid' && <> — ticket{order.ticketNumbers.length > 1 ? 's' : ''} #{order.ticketNumbers.join(', #')}</>}
            {order.status === 'pending' && (
              <>
                {' '}
                — <Link to={`/checkout/${order.id}`}>pay now</Link>
              </>
            )}
            <span className="muted"> · {formatDate(order.createdAt)}</span>
          </li>
        ))}
      </ul>
    </section>
  )
}
