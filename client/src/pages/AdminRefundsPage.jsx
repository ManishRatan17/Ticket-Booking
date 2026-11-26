// Admin → Refunds: money that bought no tickets, going back. Pending ones first, with the provider's
// last error and a Retry button.
import { useCallback, useEffect, useState } from 'react'
import { listRefunds, retryRefund, withFreshRole } from '../api/admin.js'
import { Alert } from '../components/Alert.jsx'
import { errorMessage } from '../lib/errorMessages.js'
import { formatMoney, timeAgo } from '../lib/format.js'
import { REFUND_REASON_TEXT } from '../lib/refunds.js'

export function AdminRefundsPage() {
  const [refunds, setRefunds] = useState(null)
  const [error, setError] = useState(null)
  const [notice, setNotice] = useState(null)

  const load = useCallback(async () => {
    setRefunds((await withFreshRole(() => listRefunds())).refunds)
  }, [])

  useEffect(() => {
    let active = true
    const refresh = () =>
      withFreshRole(() => listRefunds()).then(
        (result) => active && setRefunds(result.refunds),
        (err) => active && setError(errorMessage(err)),
      )
    refresh()
    const timer = setInterval(refresh, 10_000)
    return () => {
      active = false
      clearInterval(timer)
    }
  }, [])

  async function retry(id) {
    setError(null)
    try {
      await retryRefund(id)
      setNotice(`Refund #${id} is being retried.`)
      setTimeout(() => load().catch(() => {}), 1500)
    } catch (err) {
      setError(errorMessage(err))
    }
  }

  const pending = (refunds ?? []).filter((r) => r.status === 'pending')

  return (
    <section>
      <h1>Refunds</h1>
      <p className="muted">
        Money that was taken but bought no tickets goes back automatically (retried if the payment provider is down).
        Each payment can be refunded only once.
      </p>
      <Alert>{error}</Alert>
      <Alert kind="success">{notice}</Alert>
      {pending.length > 0 && (
        <Alert>
          {pending.length} refund{pending.length > 1 ? 's are' : ' is'} still pending.
        </Alert>
      )}

      {refunds === null && !error && <p className="muted">Loading…</p>}
      {refunds?.length === 0 && <p className="muted">No refunds. 🎉</p>}
      {refunds?.length > 0 && (
        <div className="table-wrap">
          <table className="admin-table">
            <thead>
              <tr>
                <th>#</th>
                <th>Who · event</th>
                <th>Amount</th>
                <th>Why</th>
                <th>Status</th>
                <th>Payment</th>
              </tr>
            </thead>
            <tbody>
              {refunds.map((r) => (
                <tr key={r.id}>
                  <td>{r.id}</td>
                  <td>
                    {r.userEmail ?? '(deleted user)'}
                    <div className="muted">
                      {r.eventName} · order {r.orderId}
                    </div>
                  </td>
                  <td>{formatMoney(r.amountPaise)}</td>
                  <td>{REFUND_REASON_TEXT[r.reason] ?? r.reason}</td>
                  <td>
                    {r.status === 'refunded' ? (
                      <span className="status-on_sale">Refunded {timeAgo(r.refundedAt)}</span>
                    ) : (
                      <>
                        <span className="status-sold_out">Pending</span> ({r.attempts} attempt{r.attempts === 1 ? '' : 's'})
                        {r.error && <div className="muted">{r.error}</div>}
                        <button type="button" onClick={() => retry(r.id)}>
                          Retry
                        </button>
                      </>
                    )}
                  </td>
                  <td>
                    <code>{r.paymentId}</code>
                    {r.providerRefundId && (
                      <div className="muted">
                        <code>{r.providerRefundId}</code>
                      </div>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  )
}
