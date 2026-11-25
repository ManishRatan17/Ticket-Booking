// One of my requests: its status and the conversation with the organisers.
import { useCallback, useEffect, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { getMyRequest, sendMessage } from '../api/support.js'
import { Alert } from '../components/Alert.jsx'
import { SupportThread } from '../components/SupportThread.jsx'
import { errorMessage } from '../lib/errorMessages.js'
import { KIND_TEXT, STATUS_TEXT } from '../lib/supportText.js'

export function SupportRequestPage() {
  const { id } = useParams()
  const [request, setRequest] = useState(null)
  const [error, setError] = useState(null)

  useEffect(() => {
    let active = true
    getMyRequest(id).then(
      (result) => active && setRequest(result.request),
      (err) => active && setError(errorMessage(err)),
    )
    return () => {
      active = false
    }
  }, [id])

  const send = useCallback(
    async (text) => {
      setError(null)
      try {
        setRequest((await sendMessage(id, text)).request)
      } catch (err) {
        setError(errorMessage(err))
      }
    },
    [id],
  )

  return (
    <section>
      <p>
        <Link to="/support">← Help &amp; requests</Link>
      </p>
      <Alert>{error}</Alert>
      {!request && !error && <p className="muted">Loading…</p>}
      {request && (
        <>
          <h1>
            {KIND_TEXT[request.kind]}
            {request.eventName && ` — ${request.eventName}`}
          </h1>
          <p>
            Status: <strong>{STATUS_TEXT[request.status]}</strong>
            {request.kind === 'more_tickets' && <> · asked for {request.extraTickets} more</>}
          </p>
          {request.status === 'approved' && request.kind === 'more_tickets' && (
            <Alert kind="success">
              Approved: you can now buy up to {4 + request.extraTickets} tickets for this event.{' '}
              {request.eventId && <Link to={`/events/${request.eventId}`}>Go to the event</Link>}
            </Alert>
          )}
          <SupportThread request={request} onSend={send} canWrite={request.status === 'open'} />
        </>
      )}
    </section>
  )
}
