// One event: hold 1–4 tickets, see the hold count down, release it.
// Payment (turning a hold into an order) comes in Phase 2.
import { useCallback, useEffect, useState } from 'react'
import { Link, useLocation, useParams } from 'react-router-dom'
import { getEvent, getMyHold, holdTickets, releaseHold, MAX_TICKETS_PER_HOLD } from '../api/events.js'
import { useAuth } from '../auth/useAuth.js'
import { Alert } from '../components/Alert.jsx'
import { useCountdown } from '../hooks/useCountdown.js'
import { errorMessage } from '../lib/errorMessages.js'
import { clockOffset, formatCountdown } from '../lib/serverClock.js'

// Loads the event, plus my hold if I'm signed in. Returns everything the page shows.
async function loadPage(eventId, signedIn) {
  const [{ event, serverTime }, mine] = await Promise.all([
    getEvent(eventId),
    signedIn ? getMyHold(eventId) : Promise.resolve({ hold: null }),
  ])
  return { event, hold: mine.hold, offset: clockOffset(serverTime) }
}

export function EventPage() {
  const { id } = useParams()
  const location = useLocation()
  const { status } = useAuth()
  const signedIn = status === 'signed-in'

  const [page, setPage] = useState(null) // { event, hold, offset }
  const [quantity, setQuantity] = useState(1)
  const [error, setError] = useState(null)
  const [notice, setNotice] = useState(null)
  const [busy, setBusy] = useState(false)

  const reload = useCallback(async () => {
    try {
      setPage(await loadPage(id, signedIn))
    } catch (err) {
      setError(errorMessage(err))
    }
  }, [id, signedIn])

  // First load, and again when sign-in status settles. State set only in the callbacks.
  useEffect(() => {
    if (status === 'loading') return undefined
    let active = true
    loadPage(id, signedIn).then(
      (result) => active && setPage(result),
      (err) => active && setError(errorMessage(err)),
    )
    return () => {
      active = false
    }
  }, [id, signedIn, status])

  // When the hold's time runs out, ask the server: it releases the expired hold
  // (its tickets go back on sale) and answers "no hold".
  const onHoldExpired = useCallback(() => {
    setNotice('Your hold expired and the tickets went back on sale.')
    reload()
  }, [reload])
  // When the sale opens, reload so the Hold button appears.
  const event = page?.event
  const holdSecondsLeft = useCountdown(page?.hold?.expiresAt, page?.offset ?? 0, onHoldExpired)
  const saleSecondsLeft = useCountdown(event && !event.onSale ? event.saleStartsAt : null, page?.offset ?? 0, reload)

  async function handleHold(e) {
    e.preventDefault()
    setBusy(true)
    setError(null)
    setNotice(null)
    try {
      const { hold, serverTime } = await holdTickets(id, quantity)
      setPage((p) => ({ ...p, hold, offset: clockOffset(serverTime), event: { ...p.event, available: p.event.available - hold.quantity } }))
    } catch (err) {
      setError(errorMessage(err))
      await reload() // SOLD_OUT / HOLD_EXISTS: show the real stock and my real hold
    } finally {
      setBusy(false)
    }
  }

  async function handleRelease() {
    setBusy(true)
    setError(null)
    try {
      await releaseHold(page.hold.id)
      setNotice('Released. The tickets are back on sale.')
    } catch (err) {
      setError(errorMessage(err))
    } finally {
      await reload()
      setBusy(false)
    }
  }

  if (!page) {
    return (
      <section>
        <Alert>{error}</Alert>
        {!error && <p className="muted">Loading…</p>}
        <Link to="/events">← All events</Link>
      </section>
    )
  }

  const maxChoice = Math.min(MAX_TICKETS_PER_HOLD, event.available)

  return (
    <section>
      <p>
        <Link to="/events">← All events</Link>
      </p>
      <h1>{event.name}</h1>
      <p>
        {event.available} of {event.totalTickets} tickets left
      </p>

      <Alert>{error}</Alert>
      <Alert kind="info">{notice}</Alert>

      {!event.onSale ? (
        <p>On sale in {formatCountdown(saleSecondsLeft)}</p>
      ) : page.hold ? (
        <div>
          <p>
            You're holding <strong>{page.hold.quantity}</strong> ticket{page.hold.quantity > 1 ? 's' : ''}. Hold
            expires in <strong>{formatCountdown(holdSecondsLeft)}</strong>.
          </p>
          <p className="muted">Paying for held tickets comes in the next phase of the project.</p>
          <button type="button" onClick={handleRelease} disabled={busy}>
            {busy ? 'Releasing…' : 'Release tickets'}
          </button>
        </div>
      ) : !signedIn ? (
        <p>
          <Link to="/login" state={{ from: location.pathname }}>
            Log in
          </Link>{' '}
          to hold tickets.
        </p>
      ) : event.available === 0 ? (
        <p>Sold out.</p>
      ) : (
        <form onSubmit={handleHold}>
          <label htmlFor="quantity">Tickets </label>
          <select id="quantity" value={quantity} onChange={(e) => setQuantity(Number(e.target.value))}>
            {Array.from({ length: maxChoice }, (_, i) => i + 1).map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>{' '}
          <button type="submit" disabled={busy}>
            {busy ? 'Holding…' : 'Hold tickets'}
          </button>
          <p className="muted">Held tickets are yours for 5 minutes. At most {MAX_TICKETS_PER_HOLD} per person.</p>
        </form>
      )}
    </section>
  )
}
