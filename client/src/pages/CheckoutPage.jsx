// /checkout/:id — an order waiting to be paid. (The Pay buttons arrive in step 2b.)
import { useCallback, useEffect, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { getOrder } from '../api/orders.js'
import { Alert } from '../components/Alert.jsx'
import { useCountdown } from '../hooks/useCountdown.js'
import { errorMessage } from '../lib/errorMessages.js'
import { formatMoney } from '../lib/format.js'
import { clockOffset, formatCountdown } from '../lib/serverClock.js'

export function CheckoutPage() {
  const { id } = useParams()
  const [page, setPage] = useState(null) // { order, offset }
  const [error, setError] = useState(null)

  const reload = useCallback(async () => {
    try {
      const { order, serverTime } = await getOrder(id)
      setPage({ order, offset: clockOffset(serverTime) })
    } catch (err) {
      setError(errorMessage(err))
    }
  }, [id])

  useEffect(() => {
    let active = true
    getOrder(id).then(
      ({ order, serverTime }) => active && setPage({ order, offset: clockOffset(serverTime) }),
      (err) => active && setError(errorMessage(err)),
    )
    return () => {
      active = false
    }
  }, [id])

  const order = page?.order
  // When the deadline passes, ask the server: it marks the order expired and frees the tickets.
  const secondsLeft = useCountdown(order?.status === 'pending' ? order.expiresAt : null, page?.offset ?? 0, reload)

  if (!order) {
    return (
      <section>
        <Alert>{error}</Alert>
        {!error && <p className="muted">Loading…</p>}
      </section>
    )
  }

  return (
    <section>
      <h1>Checkout</h1>
      <Alert>{error}</Alert>
      <p>
        <Link to={`/events/${order.eventId}`}>{order.eventName}</Link> — {order.quantity} ticket
        {order.quantity > 1 ? 's' : ''}
      </p>
      <p>
        Total: <strong>{formatMoney(order.amountPaise)}</strong>
      </p>

      {order.status === 'pending' && (
        <>
          <p>
            Pay within <strong>{formatCountdown(secondsLeft)}</strong> or the tickets go back on sale.
          </p>
          <p className="muted">Payment is added in the next step.</p>
        </>
      )}
      {order.status === 'expired' && <Alert>This order expired before it was paid. The tickets went back on sale.</Alert>}
    </section>
  )
}
