// Admin → Events: create an event and see all events (backend step 4b).
import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { createEvent, withFreshRole } from '../api/admin.js'
import { listEvents } from '../api/events.js'
import { Alert } from '../components/Alert.jsx'
import { FormField } from '../components/FormField.jsx'
import { errorMessage, fieldErrors } from '../lib/errorMessages.js'
import { formatDate, formatMoney } from '../lib/format.js'

const EMPTY_FORM = { name: '', totalTickets: '100', price: '499', saleStartsAt: '' }

export function AdminEventsPage() {
  const [events, setEvents] = useState(null)
  const [form, setForm] = useState(EMPTY_FORM)
  const [errors, setErrors] = useState({})
  const [error, setError] = useState(null)
  const [notice, setNotice] = useState(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    let active = true
    listEvents().then(
      (result) => active && setEvents(result.events),
      (err) => active && setError(errorMessage(err)),
    )
    return () => {
      active = false
    }
  }, [])

  const update = (name) => (e) => setForm({ ...form, [name]: e.target.value })

  async function handleSubmit(e) {
    e.preventDefault()
    setBusy(true)
    setErrors({})
    setError(null)
    setNotice(null)
    try {
      const { event } = await withFreshRole(() =>
        createEvent({
          name: form.name,
          totalTickets: Number(form.totalTickets),
          // Rupees typed by a person → whole paise for the server (₹499.50 → 49950). Never send decimals.
          pricePaise: Math.round(Number(form.price) * 100),
          // <input type="datetime-local"> gives LOCAL time without a zone ("2026-12-01T18:00").
          // new Date() reads it as local time; toISOString() sends it in UTC — unambiguous.
          // Empty = "on sale right now".
          saleStartsAt: form.saleStartsAt ? new Date(form.saleStartsAt).toISOString() : new Date().toISOString(),
        }),
      )
      setNotice(`Created "${event.name}" with ${event.totalTickets} tickets.`)
      setEvents((list) => [...(list ?? []), event])
      setForm(EMPTY_FORM)
    } catch (err) {
      setErrors(fieldErrors(err))
      setError(errorMessage(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <section>
      <h1>Events (admin)</h1>
      <Alert>{error}</Alert>
      <Alert kind="success">{notice}</Alert>

      <h2>Create an event</h2>
      <form onSubmit={handleSubmit} noValidate>
        <FormField id="name" label="Name" value={form.name} onChange={update('name')} error={errors.name} />
        <FormField
          id="totalTickets"
          label="Total tickets"
          type="number"
          min="1"
          max="100000"
          value={form.totalTickets}
          onChange={update('totalTickets')}
          error={errors.totalTickets}
        />
        <FormField
          id="price"
          label="Price per ticket (₹)"
          type="number"
          min="0"
          step="0.01"
          value={form.price}
          onChange={update('price')}
          error={errors.pricePaise}
        />
        <FormField
          id="saleStartsAt"
          label="Sale starts (empty = now)"
          type="datetime-local"
          value={form.saleStartsAt}
          onChange={update('saleStartsAt')}
          error={errors.saleStartsAt}
        />
        <button type="submit" disabled={busy}>
          {busy ? 'Creating…' : 'Create event'}
        </button>
      </form>

      <h2>All events</h2>
      {events === null && !error && <p className="muted">Loading…</p>}
      {events?.length === 0 && <p className="muted">No events yet.</p>}
      <ul>
        {events?.map((event) => (
          <li key={event.id}>
            <Link to={`/events/${event.id}`}>{event.name}</Link> — {formatMoney(event.pricePaise)} ·{' '}
            {event.available}/{event.totalTickets} left · sale
            starts {formatDate(event.saleStartsAt)}
          </li>
        ))}
      </ul>
    </section>
  )
}
