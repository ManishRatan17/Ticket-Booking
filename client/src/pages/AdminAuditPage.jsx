// Admin → Audit log: every change an admin made (newest first). Read-only: the database itself
// refuses to change or delete an entry.
import { useEffect, useState } from 'react'
import { listAudit, withFreshRole } from '../api/admin.js'
import { Alert } from '../components/Alert.jsx'
import { errorMessage } from '../lib/errorMessages.js'
import { formatDate } from '../lib/format.js'

const ACTION_TEXT = {
  'role.change': 'changed a role',
  'event.create': 'created an event',
  'event.update': 'edited an event',
  'event.cancel': 'cancelled an event',
  'job.retry': 'retried a failed job',
  'support.reply': 'answered a support request',
  'support.decide': 'decided a support request',
  'refund.retry': 'retried a refund',
  'restrictions.acknowledge': 'marked bot strikes as seen',
  'restriction.create': 'restricted an account',
  'restriction.lift': 'lifted a restriction',
}

// The details, briefly: "role: admin · pricePaise: 12300".
const describe = (details) =>
  Object.entries(details ?? {})
    .map(([k, v]) => `${k}: ${typeof v === 'object' ? JSON.stringify(v) : v}`)
    .join(' · ')

export function AdminAuditPage() {
  const [action, setAction] = useState('')
  const [entries, setEntries] = useState(null)
  const [error, setError] = useState(null)

  useEffect(() => {
    let active = true
    withFreshRole(() => listAudit(action || undefined)).then(
      (result) => active && setEntries(result.entries),
      (err) => active && setError(errorMessage(err)),
    )
    return () => {
      active = false
    }
  }, [action])

  return (
    <section>
      <h1>Audit log</h1>
      <p className="muted">Every change an admin made. Entries can't be edited or deleted, not even directly in the database.</p>
      <Alert>{error}</Alert>
      <label htmlFor="action">Show </label>
      <select id="action" value={action} onChange={(e) => setAction(e.target.value)}>
        <option value="">everything</option>
        {Object.entries(ACTION_TEXT).map(([key, text]) => (
          <option key={key} value={key}>
            {text}
          </option>
        ))}
      </select>

      {entries === null && !error && <p className="muted">Loading…</p>}
      {entries?.length === 0 && <p className="muted">Nothing yet.</p>}
      {entries?.length > 0 && (
        <div className="table-wrap">
          <table className="admin-table">
            <thead>
              <tr>
                <th>When</th>
                <th>Who</th>
                <th>Did</th>
                <th>To</th>
                <th>Details</th>
              </tr>
            </thead>
            <tbody>
              {entries.map((e) => (
                <tr key={e.id}>
                  <td>{formatDate(e.createdAt)}</td>
                  <td>{e.adminEmail}</td>
                  <td>{ACTION_TEXT[e.action] ?? e.action}</td>
                  <td>{e.targetType ? `${e.targetType} ${e.targetId ?? ''}` : '—'}</td>
                  <td className="muted">{describe(e.details)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  )
}
