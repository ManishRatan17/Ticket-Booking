// Admin → one event: its live numbers, and editing it.
// The name can change any time; price, sale time and waiting room only before the sale opens
// (the server enforces it: 409 SALE_STARTED). Tickets and lucky-draw settings are fixed at creation.
import { useCallback, useEffect, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { cancelEvent, getAdminEvent, updateEvent, withFreshRole } from '../api/admin.js'
import { Alert } from '../components/Alert.jsx'
import { FormField } from '../components/FormField.jsx'
import { EVENT_STATUS_TEXT } from '../lib/eventStatus.js'
import { errorMessage, fieldErrors } from '../lib/errorMessages.js'
import { formatDate, formatMoney } from '../lib/format.js'

// A Date → the value an <input type="datetime-local"> shows (local time, no zone).
function toLocalInput(date) {
  const d = new Date(date)
  const pad = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}

const formFrom = (e) => ({
  name: e.name,
  price: String(e.pricePaise / 100),
  saleStartsAt: toLocalInput(e.saleStartsAt),
  admissionPerSecond: e.admissionPerSecond ? String(e.admissionPerSecond) : '',
  lobbyMinutes: String(e.lobbyMinutes),
})

export function AdminEventPage() {
  const { id } = useParams()
  const [event, setEvent] = useState(null)
  const [form, setForm] = useState(null)
  const [errors, setErrors] = useState({})
  const [error, setError] = useState(null)
  const [notice, setNotice] = useState(null)
  const [busy, setBusy] = useState(false)
  const [cancelReason, setCancelReason] = useState('')

  const load = useCallback(async () => {
    const { event: fresh } = await withFreshRole(() => getAdminEvent(id))
    setEvent(fresh)
    return fresh
  }, [id])

  useEffect(() => {
    let active = true
    withFreshRole(() => getAdminEvent(id)).then(
      ({ event: fresh }) => {
        if (!active) return
        setEvent(fresh)
        setForm(formFrom(fresh))
      },
      (err) => active && setError(errorMessage(err)),
    )
    // Live numbers every 5 s (the form is left alone while you type).
    const timer = setInterval(() => load().catch(() => {}), 5000)
    return () => {
      active = false
      clearInterval(timer)
    }
  }, [id, load])

  const update = (name) => (e) => setForm({ ...form, [name]: e.target.value })
  const started = event && event.status !== 'upcoming'

  async function handleSubmit(e) {
    e.preventDefault()
    setBusy(true)
    setErrors({})
    setError(null)
    setNotice(null)
    try {
      // After the sale opened only the name may change: send only what's allowed.
      const changes = started
        ? { name: form.name }
        : {
            name: form.name,
            pricePaise: Math.round(Number(form.price) * 100),
            saleStartsAt: new Date(form.saleStartsAt).toISOString(),
            admissionPerSecond: form.admissionPerSecond ? Number(form.admissionPerSecond) : null,
            lobbyMinutes: Number(form.lobbyMinutes) || 15,
          }
      const { event: saved } = await updateEvent(id, changes)
      setEvent(saved)
      setForm(formFrom(saved))
      setNotice('Saved. The shop shows the change right away.')
    } catch (err) {
      setErrors(fieldErrors(err))
      setError(errorMessage(err))
    } finally {
      setBusy(false)
    }
  }

  // Cancelling can't be undone: the browser asks once more before sending it.
  async function handleCancel(e) {
    e.preventDefault()
    const sure = window.confirm(
      `Cancel "${event.name}"? The sale stops at once, every paid order (${event.paidOrders}) is refunded and its buyer emailed. This can't be undone.`,
    )
    if (!sure) return
    setBusy(true)
    setError(null)
    setNotice(null)
    try {
      const result = await cancelEvent(id, cancelReason)
      setNotice(
        `Cancelled. ${result.ordersCancelled} orders ended; ${result.paidOrdersRefunded} refunds (${formatMoney(result.refundTotalPaise)}) are on their way. See the Refunds page.`,
      )
      await load()
    } catch (err) {
      setError(errorMessage(err))
    } finally {
      setBusy(false)
    }
  }

  if (!event || !form) {
    return (
      <section>
        <p>
          <Link to="/admin/events">← Manage events</Link>
        </p>
        <Alert>{error}</Alert>
        {!error && <p className="muted">Loading…</p>}
      </section>
    )
  }

  return (
    <section>
      <p>
        <Link to="/admin/events">← Manage events</Link> · <Link to={`/events/${event.id}`}>Open in the shop</Link>
      </p>
      <h1>{event.name}</h1>
      <Alert>{error}</Alert>
      <Alert kind="success">{notice}</Alert>

      <div className="stat-row">
        <div className="stat">
          <strong>{EVENT_STATUS_TEXT[event.status]}</strong>
          <span>status</span>
        </div>
        <div className="stat">
          <strong>
            {event.sold} / {event.totalTickets}
          </strong>
          <span>sold</span>
        </div>
        <div className="stat">
          <strong>{event.held}</strong>
          <span>held right now</span>
        </div>
        <div className="stat">
          <strong>{event.available}</strong>
          <span>left</span>
        </div>
        <div className="stat">
          <strong>{formatMoney(event.revenuePaise)}</strong>
          <span>{event.paidOrders} paid orders</span>
        </div>
        {event.admissionPerSecond && (
          <div className="stat">
            <strong>{event.inLine}</strong>
            <span>in the waiting room</span>
          </div>
        )}
        {event.luckyDraw && (
          <div className="stat">
            <strong>
              {event.luckyDraw.left} / {event.luckyDraw.tickets}
            </strong>
            <span>lucky draw left · {event.luckyDraw.entered} entered</span>
          </div>
        )}
      </div>
      <p className="muted">Sale starts {formatDate(event.saleStartsAt)}. Numbers refresh every 5 seconds.</p>

      {event.cancelledAt && (
        <div className="panel">
          <p>
            <strong>Cancelled</strong> {formatDate(event.cancelledAt)}: {event.cancelReason}
          </p>
          <p className="muted">
            Paid orders were cancelled and refunded (<Link to="/admin/refunds">Refunds</Link>). A cancelled event
            can't be edited.
          </p>
        </div>
      )}

      {!event.cancelledAt && (
        <>
          <h2>Edit</h2>
          {started && (
            <p className="muted">
              The sale has started, so only the name can change now (changing the price or time after people queued
              or paid would be unfair).
            </p>
          )}
          <form onSubmit={handleSubmit} noValidate>
            <FormField id="name" label="Name" value={form.name} onChange={update('name')} error={errors.name} />
            <FormField id="price" label="Price per ticket (₹)" type="number" min="0" step="0.01" value={form.price} onChange={update('price')} error={errors.pricePaise} disabled={started} />
            <FormField id="saleStartsAt" label="Sale starts" type="datetime-local" value={form.saleStartsAt} onChange={update('saleStartsAt')} error={errors.saleStartsAt} disabled={started} />
            <FormField
              id="admissionPerSecond"
              label="Waiting room: people let in per second (empty = none)"
              type="number"
              min="1"
              value={form.admissionPerSecond}
              onChange={update('admissionPerSecond')}
              error={errors.admissionPerSecond}
              disabled={started}
            />
            <FormField id="lobbyMinutes" label="Waiting room opens this many minutes before" type="number" min="1" max="1440" value={form.lobbyMinutes} onChange={update('lobbyMinutes')} error={errors.lobbyMinutes} disabled={started} />
            <p className="muted">Tickets ({event.totalTickets}) and the lucky-draw settings are fixed once an event exists.</p>
            <button type="submit" disabled={busy}>
              {busy ? 'Saving…' : 'Save'}
            </button>
          </form>

          <h2>Cancel this event</h2>
          <p className="muted">
            Stops the sale and the waiting room at once, ends unpaid orders, refunds every paid order and emails its buyer.
            It can't be undone.
          </p>
          <form onSubmit={handleCancel} noValidate>
            <FormField
              id="cancelReason"
              label="Reason (shown to customers and in their email)"
              value={cancelReason}
              onChange={(e) => setCancelReason(e.target.value)}
            />
            <button type="submit" disabled={busy || cancelReason.trim().length < 3}>
              Cancel event and refund everyone
            </button>
          </form>
        </>
      )}
    </section>
  )
}
