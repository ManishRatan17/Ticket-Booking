// "Help": my requests to the organisers, and a form for a new one.
// /support?kind=more_tickets&event=12 fills in the form (the event page links here at the limit).
import { useEffect, useState } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router-dom'
import { createRequest, listMyRequests } from '../api/support.js'
import { listEvents } from '../api/events.js'
import { Alert } from '../components/Alert.jsx'
import { errorMessage, fieldErrors } from '../lib/errorMessages.js'
import { timeAgo } from '../lib/format.js'
import { KIND_TEXT, STATUS_TEXT } from '../lib/supportText.js'

export function SupportPage() {
  const [params] = useSearchParams()
  const navigate = useNavigate()
  const [requests, setRequests] = useState(null)
  const [events, setEvents] = useState([])
  const [form, setForm] = useState({
    kind: params.get('kind') === 'more_tickets' ? 'more_tickets' : 'question',
    eventId: params.get('event') ?? '',
    extraTickets: '2',
    message: '',
  })
  const [errors, setErrors] = useState({})
  const [error, setError] = useState(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    let active = true
    Promise.all([listMyRequests(), listEvents()]).then(
      ([mine, all]) => {
        if (!active) return
        setRequests(mine.requests)
        setEvents(all.events)
      },
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
    try {
      const eventId = form.eventId ? Number(form.eventId) : null
      const body =
        form.kind === 'more_tickets'
          ? { kind: 'more_tickets', eventId, extraTickets: Number(form.extraTickets), message: form.message }
          : { kind: 'question', eventId, message: form.message }
      const { request } = await createRequest(body)
      navigate(`/support/${request.id}`)
    } catch (err) {
      if (err.code === 'REQUEST_EXISTS' && err.details?.requestId) {
        navigate(`/support/${err.details.requestId}`) // already asked: continue that conversation
        return
      }
      setErrors(fieldErrors(err))
      setError(errorMessage(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <section>
      <h1>Help &amp; requests</h1>
      <Alert>{error}</Alert>

      <h2>Ask the organisers</h2>
      <form onSubmit={handleSubmit} noValidate>
        <div className="field">
          <label htmlFor="kind">What is it about?</label>
          <select id="kind" value={form.kind} onChange={update('kind')}>
            <option value="more_tickets">I'd like to buy more tickets than the limit</option>
            <option value="question">A question</option>
          </select>
        </div>
        <div className="field">
          <label htmlFor="eventId">Event{form.kind === 'question' && ' (optional)'}</label>
          <select id="eventId" value={form.eventId} onChange={update('eventId')}>
            <option value="">{form.kind === 'more_tickets' ? 'Choose an event…' : 'No particular event'}</option>
            {events.map((e) => (
              <option key={e.id} value={e.id}>
                {e.name}
              </option>
            ))}
          </select>
          {errors.eventId && <p className="field-error">{errors.eventId}</p>}
        </div>
        {form.kind === 'more_tickets' && (
          <div className="field">
            <label htmlFor="extraTickets">How many more (on top of the normal 4)?</label>
            <select id="extraTickets" value={form.extraTickets} onChange={update('extraTickets')}>
              {[1, 2, 3, 4].map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </select>
          </div>
        )}
        <div className="field">
          <label htmlFor="message">Message</label>
          <textarea id="message" rows={4} maxLength={2000} value={form.message} onChange={update('message')} />
          {errors.message && <p className="field-error">{errors.message}</p>}
          <p className="field-hint">For more tickets, tell us why (for example: a family of 6).</p>
        </div>
        <button type="submit" disabled={busy}>
          {busy ? 'Sending…' : 'Send'}
        </button>
      </form>

      <h2>My requests</h2>
      {requests === null && !error && <p className="muted">Loading…</p>}
      {requests?.length === 0 && <p className="muted">You haven't asked anything yet.</p>}
      {requests?.length > 0 && (
        <ul>
          {requests.map((r) => (
            <li key={r.id}>
              <Link to={`/support/${r.id}`}>
                {KIND_TEXT[r.kind]}
                {r.eventName && ` — ${r.eventName}`}
                {r.kind === 'more_tickets' && ` (+${r.extraTickets})`}
              </Link>{' '}
              · <strong>{STATUS_TEXT[r.status]}</strong> · <span className="muted">{timeAgo(r.updatedAt)}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}
