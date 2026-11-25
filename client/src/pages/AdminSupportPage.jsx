// Admin inbox: open requests first (oldest first), the conversation, and the decision.
import { useCallback, useEffect, useState } from 'react'
import { decideSupport, getSupport, listSupport, replySupport } from '../api/support.js'
import { withFreshRole } from '../api/admin.js'
import { Alert } from '../components/Alert.jsx'
import { SupportThread } from '../components/SupportThread.jsx'
import { errorMessage } from '../lib/errorMessages.js'
import { timeAgo } from '../lib/format.js'
import { KIND_TEXT, STATUS_TEXT } from '../lib/supportText.js'

export function AdminSupportPage() {
  const [filter, setFilter] = useState('open')
  const [requests, setRequests] = useState(null)
  const [selected, setSelected] = useState(null)
  const [decisionNote, setDecisionNote] = useState('')
  const [error, setError] = useState(null)
  const [notice, setNotice] = useState(null)
  const [busy, setBusy] = useState(false)

  const loadList = useCallback(async () => {
    const { requests: list } = await withFreshRole(() => listSupport(filter || undefined))
    setRequests(list)
  }, [filter])

  useEffect(() => {
    let active = true
    withFreshRole(() => listSupport(filter || undefined)).then(
      (result) => active && setRequests(result.requests),
      (err) => active && setError(errorMessage(err)),
    )
    return () => {
      active = false
    }
  }, [filter])

  async function open(id) {
    setError(null)
    setNotice(null)
    try {
      setSelected((await getSupport(id)).request)
      setDecisionNote('')
    } catch (err) {
      setError(errorMessage(err))
    }
  }

  const reply = useCallback(
    async (text) => {
      setError(null)
      try {
        setSelected((await replySupport(selected.id, text)).request)
        await loadList()
      } catch (err) {
        setError(errorMessage(err))
      }
    },
    [selected, loadList],
  )

  async function decide(decision) {
    setBusy(true)
    setError(null)
    try {
      const { request } = await decideSupport(selected.id, decision, decisionNote.trim() || undefined)
      setSelected(request)
      setNotice(
        decision === 'approved' && request.kind === 'appeal'
          ? `Appeal upheld: ${request.userEmail}'s restriction is overturned.`
          : decision === 'approved'
          ? `Approved: ${request.userEmail} may now buy up to ${4 + request.extraTickets} tickets for ${request.eventName}.`
          : `Request ${STATUS_TEXT[decision].toLowerCase()}.`,
      )
      await loadList()
    } catch (err) {
      setError(errorMessage(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <section>
      <h1>Support inbox (admin)</h1>
      <Alert>{error}</Alert>
      <Alert kind="success">{notice}</Alert>

      <label htmlFor="filter">Show </label>
      <select id="filter" value={filter} onChange={(e) => setFilter(e.target.value)}>
        <option value="open">Open</option>
        <option value="">All</option>
        <option value="approved">Approved</option>
        <option value="declined">Declined</option>
        <option value="closed">Closed</option>
      </select>

      {requests === null && !error && <p className="muted">Loading…</p>}
      {requests?.length === 0 && <p className="muted">Nothing here.</p>}
      {requests?.length > 0 && (
        <ul>
          {requests.map((r) => (
            <li key={r.id}>
              <button type="button" className="link-button" onClick={() => open(r.id)}>
                #{r.id} {KIND_TEXT[r.kind]}
                {r.eventName && ` — ${r.eventName}`}
                {r.kind === 'more_tickets' && ` (+${r.extraTickets})`}
              </button>{' '}
              · {r.userEmail} · <strong>{STATUS_TEXT[r.status]}</strong>
              {r.awaitingReply && <strong> · needs a reply</strong>} ·{' '}
              <span className="muted">asked {timeAgo(r.createdAt)}</span>
            </li>
          ))}
        </ul>
      )}

      {selected && (
        <div className="panel">
          <h2>
            #{selected.id} {KIND_TEXT[selected.kind]}
            {selected.eventName && ` — ${selected.eventName}`}
          </h2>
          <p>
            From <strong>{selected.userEmail}</strong> · {STATUS_TEXT[selected.status]}
            {selected.kind === 'more_tickets' && <> · asks for {selected.extraTickets} more (limit would be {4 + selected.extraTickets})</>}
          </p>
          <SupportThread request={selected} onSend={reply} youAreAdmin canWrite />

          {selected.status === 'open' && (
            <div>
              <label htmlFor="decisionNote">Message with the decision (optional)</label>
              <textarea id="decisionNote" rows={2} maxLength={2000} value={decisionNote} onChange={(e) => setDecisionNote(e.target.value)} />
              {selected.kind !== 'question' && (
                <>
                  <button type="button" onClick={() => decide('approved')} disabled={busy}>
                    {selected.kind === 'appeal' ? 'Uphold appeal (lift the restriction)' : `Approve (+${selected.extraTickets})`}
                  </button>{' '}
                  <button type="button" onClick={() => decide('declined')} disabled={busy}>
                    Decline
                  </button>{' '}
                </>
              )}
              <button type="button" onClick={() => decide('closed')} disabled={busy}>
                Close
              </button>
            </div>
          )}
        </div>
      )}
    </section>
  )
}
