// One event: hold 1–4 tickets, see the hold count down, release it.
// Payment (turning a hold into an order) comes in Phase 2.
import { useCallback, useEffect, useRef, useState } from 'react'
import { Link, useLocation, useNavigate, useParams } from 'react-router-dom'
import { getEvent, getMyHold, holdTickets, releaseHold, MAX_TICKETS_PER_HOLD } from '../api/events.js'
import { createOrder } from '../api/orders.js'
import { formatMoney } from '../lib/format.js'
import { useAuth } from '../auth/useAuth.js'
import { Alert } from '../components/Alert.jsx'
import { useCountdown } from '../hooks/useCountdown.js'
import { errorMessage } from '../lib/errorMessages.js'
import { clockOffset, formatCountdown } from '../lib/serverClock.js'
import { useQueueStatus } from '../hooks/useQueueStatus.js'
import { WaitingRoom } from '../components/WaitingRoom.jsx'
import { useHumanCheck } from '../hooks/useHumanCheck.js'
import { LuckyDrawPanel } from '../components/LuckyDrawPanel.jsx'
import { eventStatus } from '../lib/eventStatus.js'

// Loads the event, plus my hold if I'm signed in. Returns everything the page shows.
async function loadPage(eventId, signedIn) {
  const [{ event, serverTime }, mine] = await Promise.all([
    getEvent(eventId),
    signedIn ? getMyHold(eventId) : Promise.resolve({ hold: null, purchase: null }),
  ])
  // purchase = { bought, limit }: tickets I already bought here, and the per-person limit (Phase 5b)
  return { event, hold: mine.hold, purchase: mine.purchase, offset: clockOffset(serverTime) }
}

export function EventPage() {
  const { id } = useParams()
  const location = useLocation()
  const navigate = useNavigate()
  // One idempotency key per hold: clicking Checkout twice (or a retry) sends the SAME key,
  // so the server returns the same order instead of making a second one.
  const checkoutKey = useRef(null)
  const { status, user, reload: reloadMe } = useAuth()
  const signedIn = status === 'signed-in'

  const [page, setPage] = useState(null) // { event, hold, purchase, offset }
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

  // Waiting room (Phase 4): only for events with an admission rate. Not needed once you hold tickets.
  const hasRoom = Boolean(event?.admissionPerSecond)
  const isAdmin = user?.role === 'admin' // admins run the sale, they don't buy (the server refuses too)
  const cancelled = Boolean(event?.cancelledAt)
  const queue = useQueueStatus(id, signedIn && !isAdmin && hasRoom && !page?.hold && !cancelled)
  const admitted = queue.status?.status === 'admitted'
  // A lucky-draw winner may hold lucky-draw tickets while their lucky pass lasts, line or no line.
  const draw = queue.status?.lottery
  const luckyWin = Boolean(draw?.state === 'drawing' && draw.won?.passExpiresInSeconds > 0)
  const human = useHumanCheck() // joining the queue needs the "are you a person?" check
  // Counts down to the lobby window; at 0 the Join button appears (no reload needed).
  const lobbyOpensIn = useCountdown(
    queue.status?.status === 'not_in_queue' ? queue.status.lobbyOpensAt : null,
    page?.offset ?? 0,
  )

  async function handleJoin() {
    setError(null)
    try {
      await queue.join(human.token)
    } catch (err) {
      if (err.code === 'ACCOUNT_RESTRICTED') reloadMe() // show the banner everywhere
      setError(errorMessage(err))
      human.reset() // the token may have been used: a fresh widget for the next try
    }
  }

  async function handleHold(e) {
    e.preventDefault()
    setBusy(true)
    setError(null)
    setNotice(null)
    try {
      const { hold, serverTime } = await holdTickets(id, quantity)
      setPage((p) => ({ ...p, hold, offset: clockOffset(serverTime), event: { ...p.event, available: p.event.available - hold.quantity } }))
    } catch (err) {
      if (err.code === 'ACCOUNT_RESTRICTED') reloadMe() // show the banner everywhere
      setError(errorMessage(err))
      await reload() // SOLD_OUT / HOLD_EXISTS: show the real stock and my real hold
    } finally {
      setBusy(false)
    }
  }

  async function handleCheckout() {
    if (checkoutKey.current?.holdId !== page.hold.id) {
      checkoutKey.current = { holdId: page.hold.id, key: crypto.randomUUID() }
    }
    setBusy(true)
    setError(null)
    try {
      const { order } = await createOrder(page.hold.id, checkoutKey.current.key)
      navigate(`/checkout/${order.id}`)
    } catch (err) {
      if (err.code === 'ORDER_EXISTS' && err.details?.orderId) {
        navigate(`/checkout/${err.details.orderId}`) // started in another tab: continue that one
        return
      }
      setError(errorMessage(err))
      await reload()
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

  // Offer only what I may still buy: per hold, in stock, and under my per-person limit.
  const canStillBuy = page.purchase ? page.purchase.limit - page.purchase.bought : MAX_TICKETS_PER_HOLD
  // A lucky-draw winner buys from the draw's own tickets, up to the per-winner limit.
  const ticketsOnOffer = luckyWin ? draw.ticketsLeft : event.available
  const maxChoice = Math.min(luckyWin ? draw.perWinner : MAX_TICKETS_PER_HOLD, ticketsOnOffer, canStillBuy)
  const leftPercent = event.totalTickets ? Math.round((event.available / event.totalTickets) * 100) : 0
  const saleStatus = eventStatus(event)

  return (
    <section className="event-page">
      <p>
        <Link to="/events">← All events</Link>
      </p>
      <header className="event-hero">
        <span className={`pill pill--${saleStatus.tone}`}>{saleStatus.text}</span>
        <h1>{event.name}</h1>
        <p className="event-hero__meta">
          <span>
            <strong>{formatMoney(event.pricePaise)}</strong> per ticket
          </span>
          <span>
            {event.available} of {event.totalTickets} left
          </span>
          {hasRoom && !cancelled && <span>Waiting room · {event.admissionPerSecond} people/s</span>}
        </p>
        <div className="availability" aria-hidden="true">
          <span style={{ width: `${leftPercent}%` }} />
        </div>
      </header>

      <Alert>{error}</Alert>
      <Alert kind="info">{notice}</Alert>

      {draw ? (
        <LuckyDrawPanel draw={draw} eventId={event.id} userId={user?.id} />
      ) : (
        event.lotteryTickets > 0 &&
        !event.lotteryClosedAt &&
        !cancelled && (
          <p className="muted">
            🎟 {event.lotteryTickets} of the tickets go to a lucky draw among everyone in the waiting room.
          </p>
        )
      )}

      <div className="panel purchase-card">
      {cancelled ? (
        <div>
          <p>
            <strong>This event has been cancelled.</strong> {event.cancelReason}
          </p>
          <p>
            Everyone who paid gets their money back automatically and is told by email.{' '}
            {signedIn && !isAdmin && <Link to="/orders">See your orders</Link>}
          </p>
        </div>
      ) : page.hold ? (
        <div>
          <p>
            You're holding <strong>{page.hold.quantity}</strong> ticket{page.hold.quantity > 1 ? 's' : ''}. Hold
            expires in <strong>{formatCountdown(holdSecondsLeft)}</strong>.
          </p>
          <button type="button" className="button" onClick={handleCheckout} disabled={busy}>
            Checkout — {formatMoney(event.pricePaise * page.hold.quantity)}
          </button>{' '}
          <button type="button" className="button button-secondary" onClick={handleRelease} disabled={busy}>
            Release tickets
          </button>
        </div>
      ) : isAdmin ? (
        <div>
          <p>
            You're signed in as an <strong>admin</strong>. Admin accounts can't buy tickets: the people who run the
            sale don't compete with fans for it. To buy, use a normal account.
          </p>
          <p>
            <Link to={`/admin/events/${event.id}`}>See this event's live numbers</Link>
          </p>
        </div>
      ) : !signedIn ? (
        <p>
          <Link to="/login" state={{ from: location.pathname }}>
            Log in
          </Link>{' '}
          {hasRoom ? 'to join the queue.' : 'to hold tickets.'}
        </p>
      ) : hasRoom && !admitted && !luckyWin ? (
        // You can queue before the sale opens; admission starts when it does.
        <WaitingRoom
          status={queue.status}
          onJoin={handleJoin}
          saleOpensIn={event.onSale ? 0 : saleSecondsLeft}
          lobbyOpensIn={lobbyOpensIn}
          human={human}
        />
      ) : !event.onSale ? (
        <p>On sale in {formatCountdown(saleSecondsLeft)}</p>
      ) : ticketsOnOffer === 0 ? (
        <p>{luckyWin ? 'All lucky-draw tickets are taken or held right now.' : 'Sold out.'}</p>
      ) : canStillBuy <= 0 ? (
        <p>
          You've bought the maximum of {page.purchase.limit} tickets for this event.{' '}
          <Link to="/orders">See your tickets</Link> ·{' '}
          <Link to={`/support?kind=more_tickets&event=${event.id}`}>Ask the organisers for more</Link>
        </p>
      ) : (
        <form onSubmit={handleHold}>
          {luckyWin && (
            <p>
              🎉 <strong>Lucky draw:</strong> choose up to {draw.perWinner} lucky-draw ticket{draw.perWinner > 1 ? 's' : ''}.
            </p>
          )}
          {admitted && !luckyWin && (
            <p>
              <strong>It's your turn!</strong> Choose your tickets within{' '}
              {formatCountdown(queue.status.passExpiresInSeconds)}.
            </p>
          )}
          <label htmlFor="quantity">Tickets </label>
          <select id="quantity" value={quantity} onChange={(e) => setQuantity(Number(e.target.value))}>
            {Array.from({ length: maxChoice }, (_, i) => i + 1).map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>{' '}
          <button type="submit" className="button" disabled={busy}>
            {busy ? 'Holding…' : 'Hold tickets'}
          </button>
          <p className="muted">
            Held tickets are yours for 5 minutes. At most {page.purchase?.limit ?? MAX_TICKETS_PER_HOLD} per person
            {page.purchase?.bought > 0 && ` (you already have ${page.purchase.bought})`}.
          </p>
        </form>
      )}
      </div>
    </section>
  )
}
