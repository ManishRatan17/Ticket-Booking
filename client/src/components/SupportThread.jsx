// One conversation: messages oldest first, and a box to write the next one.
import { useState } from 'react'
import { timeAgo } from '../lib/format.js'
import { STATUS_TEXT } from '../lib/supportText.js'

// youAreAdmin: label messages from the admin's point of view ("You" vs the person).
export function SupportThread({ request, onSend, youAreAdmin = false, canWrite = true }) {
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)

  async function handleSubmit(e) {
    e.preventDefault()
    if (!text.trim()) return
    setBusy(true)
    try {
      await onSend(text.trim())
      setText('')
    } finally {
      setBusy(false)
    }
  }

  const who = (m) => (m.fromAdmin ? (youAreAdmin ? 'You (organisers)' : 'Organisers') : youAreAdmin ? 'Them' : 'You')

  return (
    <div>
      <ul className="thread">
        {request.messages.map((m) => (
          <li key={m.id} className={m.fromAdmin ? 'from-admin' : 'from-person'}>
            <p className="muted">
              {who(m)} · {timeAgo(m.createdAt)}
            </p>
            <p>{m.body}</p>
          </li>
        ))}
      </ul>
      {canWrite ? (
        <form onSubmit={handleSubmit}>
          <label htmlFor="reply">Write a message</label>
          <textarea id="reply" rows={3} maxLength={2000} value={text} onChange={(e) => setText(e.target.value)} />
          <button type="submit" disabled={busy || !text.trim()}>
            {busy ? 'Sending…' : 'Send'}
          </button>
        </form>
      ) : (
        <p className="muted">This request is {STATUS_TEXT[request.status].toLowerCase()}; it takes no more messages.</p>
      )}
    </div>
  )
}
