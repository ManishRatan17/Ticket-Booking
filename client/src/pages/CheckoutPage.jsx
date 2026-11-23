// /checkout/:id — pay for an order (with the fake payment provider), then see the result.
import { useCallback, useEffect, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { getOrder } from '../api/orders.js'
import { startFakePayment } from '../api/payments.js'
import { Alert } from '../components/Alert.jsx'
import { useCountdown } from '../hooks/useCountdown.js'
import { errorMessage } from '../lib/errorMessages.js'
import { formatMoney } from '../lib/format.js'
import { clockOffset, formatCountdown } from '../lib/serverClock.js'

const FAILURE_TEXT = {
  payment_failed: 'The payment failed. Your tickets went back on sale.',
  amount_mismatch: 'The amount paid did not match the order. The payment will be refunded.',
  sold_out_after_expiry:
    'Your payment arrived after your hold expired, and the tickets were sold out by then. The payment will be refunded.',
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

export function CheckoutPage() {
  const { id } = useParams()
  const [page, setPage] = useState(null) // { order, offset }
  const [error, setError] = useState(null)
  const [paying, setPaying] = useState(false)

  const reload = useCallback(async () => {
    try {
      const { order, serverTime } = await getOrder(id)
      setPage({ order, offset: clockOffset(serverTime) })
      return order
    } catch (err) {
      setError(errorMessage(err))
      return null
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

  async function pay(outcome) {
    setPaying(true)
    setError(null)
    try {
      await startFakePayment(id, outcome)
      // The provider tells our SERVER (by webhook), not this page. So ask the server, a few
      // times, until the order is no longer pending (polling; Phase 4 brings live updates).
      for (let attempt = 0; attempt < 30; attempt++) {
        await sleep(500)
        const latest = await reload()
        if (!latest || latest.status !== 'pending') break
      }
    } catch (err) {
      setError(errorMessage(err))
    } finally {
      setPaying(false)
    }
  }

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
          {paying ? (
            <p>Waiting for the payment provider to confirm…</p>
          ) : (
            <p>
              <button type="button" onClick={() => pay('success')}>
                Pay {formatMoney(order.amountPaise)}
              </button>{' '}
              <button type="button" onClick={() => pay('failure')}>
                Simulate a failed payment
              </button>
            </p>
          )}
          <p className="muted">This is a fake payment provider for development — no real money moves.</p>
        </>
      )}

      {order.status === 'paid' && (
        <Alert kind="success">
          Paid! Your ticket number{order.ticketNumbers.length > 1 ? 's' : ''}: {order.ticketNumbers.join(', ')}.{' '}
          <Link to="/orders">See all your orders</Link>
        </Alert>
      )}
      {order.status === 'failed' && <Alert>{FAILURE_TEXT[order.failureReason] ?? 'The payment did not go through.'}</Alert>}
      {order.status === 'expired' && <Alert>This order expired before it was paid. The tickets went back on sale.</Alert>}
    </section>
  )
}
