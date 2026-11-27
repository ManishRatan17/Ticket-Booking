// Paying for a bus / train booking: Razorpay when the server has it, else the built-in fake provider
// (development). The page never decides the result: the SERVER does (signed webhook or Razorpay's
// verified answer), so after paying we ask it until the booking is no longer "held".
import { useEffect, useState } from 'react'
import { getPublicConfig } from '../../api/config.js'
import { openRazorpayCheckout } from '../../lib/razorpayCheckout.js'
import { errorMessage } from '../../lib/errorMessages.js'
import { formatMoney } from '../../lib/format.js'
import { Alert } from '../Alert.jsx'

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

export function PaymentPanel({ api, booking, email, onSettled }) {
  const [provider, setProvider] = useState(null)
  const [paying, setPaying] = useState(false)
  const [error, setError] = useState(null)

  useEffect(() => {
    let active = true
    getPublicConfig().then(
      (config) => active && setProvider(config.payments?.provider ?? 'fake'),
      () => active && setProvider('fake'),
    )
    return () => {
      active = false
    }
  }, [])

  // Ask the server until the payment is decided (about 15 s at most).
  async function waitForResult() {
    for (let attempt = 0; attempt < 30; attempt++) {
      const { booking: latest } = await api.get(booking.id)
      if (latest.status !== 'held' || latest.payment?.paid) return onSettled(latest)
      await sleep(500)
    }
    setError('The payment is taking longer than usual. This page will show it once it arrives; you can refresh.')
  }

  async function run(action) {
    setPaying(true)
    setError(null)
    try {
      await action()
    } catch (err) {
      setError(errorMessage(err))
    } finally {
      setPaying(false)
    }
  }

  const payFake = (outcome) =>
    run(async () => {
      await api.payFake(booking.id, outcome)
      if (outcome === 'failure') {
        await sleep(800)
        setError('The payment was declined. Nothing was charged; you can try again while your seats are held.')
        return
      }
      await waitForResult()
    })

  const payRazorpay = () =>
    run(async () => {
      const details = await api.payRazorpay(booking.id)
      const answer = await openRazorpayCheckout(details, {
        email,
        onAttemptFailed: (reason) => setError(`That payment attempt failed${reason ? `: ${reason}` : ''}. You can try again.`),
      })
      if (!answer) return // closed without paying: nothing changed
      await api.verifyRazorpay(booking.id, answer)
      await waitForResult()
    })

  return (
    <div className="payment-panel">
      <p className="payment-panel__total">
        Total <strong>{formatMoney(booking.amountPaise)}</strong>
      </p>
      <Alert>{error}</Alert>
      {paying ? (
        <p className="muted" role="status">
          Waiting for the payment to be confirmed…
        </p>
      ) : provider === 'razorpay' ? (
        <button type="button" className="button" onClick={payRazorpay}>
          Pay {formatMoney(booking.amountPaise)} securely
        </button>
      ) : provider === 'fake' ? (
        <>
          <p className="muted">Development payments: no real money. Choose what the "bank" answers.</p>
          <div className="payment-panel__actions">
            <button type="button" className="button" onClick={() => payFake('success')}>
              Pay {formatMoney(booking.amountPaise)}
            </button>
            <button type="button" className="button button-secondary" onClick={() => payFake('failure')}>
              Simulate a declined card
            </button>
          </div>
        </>
      ) : (
        <p className="muted">Loading payment options…</p>
      )}
    </div>
  )
}
