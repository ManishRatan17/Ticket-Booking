// Admin: accounts restricted for bot-like activity (Phase 5e). See the evidence, lift (or overturn
// a mistake), or restrict someone by hand.
import { useCallback, useEffect, useState } from 'react'
import { acknowledgeRestrictions, liftRestriction, listRestrictions, restrictUser, withFreshRole } from '../api/admin.js'
import { Alert } from '../components/Alert.jsx'
import { errorMessage } from '../lib/errorMessages.js'
import { timeAgo } from '../lib/format.js'

const SIGNAL_TEXT = {
  rate_limited: 'actions refused by rate limits',
  missing_bot_token: 'queue joins without the "are you a person?" check',
  bad_bot_token: 'failed "are you a person?" checks',
}

function Evidence({ evidence }) {
  if (evidence?.manual) return <span className="muted">restricted by an admin</span>
  if (!evidence?.signals) return null
  return (
    <span className="muted">
      score {evidence.score} in {evidence.windowMinutes} min:{' '}
      {Object.entries(evidence.signals)
        .map(([kind, count]) => `${count} × ${SIGNAL_TEXT[kind] ?? kind}`)
        .join(', ')}
    </span>
  )
}

export function AdminRestrictionsPage() {
  const [activeOnly, setActiveOnly] = useState(true)
  const [list, setList] = useState(null)
  const [error, setError] = useState(null)
  const [notice, setNotice] = useState(null)
  const [form, setForm] = useState({ email: '', kind: 'suspended', days: '15', reason: '' })

  const load = useCallback(async () => {
    setList((await withFreshRole(() => listRestrictions(activeOnly))).restrictions)
  }, [activeOnly])

  useEffect(() => {
    let active = true
    withFreshRole(() => listRestrictions(activeOnly)).then(
      (result) => active && setList(result.restrictions),
      (err) => active && setError(errorMessage(err)),
    )
    return () => {
      active = false
    }
  }, [activeOnly])

  // NEW = automatic restrictions no admin has marked as seen yet.
  const unseen = (list ?? []).filter((r) => r.automatic && !r.acknowledgedAt)

  async function markSeen() {
    try {
      await acknowledgeRestrictions()
      window.dispatchEvent(new Event('restrictions-seen')) // the nav badge updates at once
      await load()
    } catch (err) {
      setError(errorMessage(err))
    }
  }

  async function lift(r, overturn) {
    const reason = window.prompt(overturn ? 'Why was this a mistake?' : 'Why lift it early?')
    if (!reason) return
    setError(null)
    try {
      await liftRestriction(r.id, { reason, overturn })
      setNotice(`${r.userEmail}: ${overturn ? 'overturned (it will not count as a strike)' : 'lifted'}.`)
      await load()
    } catch (err) {
      setError(errorMessage(err))
    }
  }

  async function handleRestrict(e) {
    e.preventDefault()
    setError(null)
    try {
      const { restriction } = await restrictUser({
        email: form.email,
        kind: form.kind,
        days: Number(form.days) || 15,
        reason: form.reason,
      })
      setNotice(`${restriction.userEmail} is now ${restriction.kind}.`)
      setForm({ email: '', kind: 'suspended', days: '15', reason: '' })
      await load()
    } catch (err) {
      setError(errorMessage(err))
    }
  }

  const update = (name) => (e) => setForm({ ...form, [name]: e.target.value })

  return (
    <section>
      <h1>Restrictions (admin)</h1>
      <p className="muted">
        Automatic: 20 points of bot-like signals within 10 minutes → a strike. First strike: booking paused for 15
        days. Second within a year: banned. Overturned restrictions don't count as strikes.
      </p>
      <Alert>{error}</Alert>
      <Alert kind="success">{notice}</Alert>

      {unseen.length > 0 && (
        <div className="alert alert-error" role="alert">
          <strong>
            {unseen.length} new account{unseen.length > 1 ? 's' : ''} caught using a bot:
          </strong>
          <ul>
            {unseen.map((r) => (
              <li key={r.id}>
                ⚠ <strong>{r.userEmail}</strong> was {r.kind === 'banned' ? 'banned' : 'suspended'} for bot-like activity
                ({timeAgo(r.startsAt)}): <Evidence evidence={r.evidence} />
              </li>
            ))}
          </ul>
          <button type="button" onClick={markSeen}>
            Mark as seen
          </button>
        </div>
      )}

      <label>
        <input type="checkbox" checked={activeOnly} onChange={(e) => setActiveOnly(e.target.checked)} /> Only those in force
      </label>

      {list === null && !error && <p className="muted">Loading…</p>}
      {list?.length === 0 && <p className="muted">None.</p>}
      {list?.length > 0 && (
        <ul>
          {list.map((r) => (
            <li key={r.id}>
              {r.automatic && !r.acknowledgedAt && <span className="badge badge-alert">new</span>} <strong>{r.userEmail}</strong> — {r.kind}
              {r.endsAt ? ` until ${new Date(r.endsAt).toLocaleDateString()}` : ' (permanent)'} · {r.automatic ? 'automatic' : 'by an admin'} ·{' '}
              {timeAgo(r.startsAt)}
              {r.liftedAt && <> · lifted{r.overturned && ' (overturned)'}</>}
              <br />
              {r.reason} · <Evidence evidence={r.evidence} />
              {!r.liftedAt && (
                <>
                  <br />
                  <button type="button" onClick={() => lift(r, false)}>
                    Lift early
                  </button>{' '}
                  <button type="button" onClick={() => lift(r, true)}>
                    Overturn (a mistake)
                  </button>
                </>
              )}
            </li>
          ))}
        </ul>
      )}

      <h2>Restrict an account by hand</h2>
      <form onSubmit={handleRestrict}>
        <div className="field">
          <label htmlFor="r-email">Email</label>
          <input id="r-email" type="email" value={form.email} onChange={update('email')} required />
        </div>
        <div className="field">
          <label htmlFor="r-kind">Kind</label>
          <select id="r-kind" value={form.kind} onChange={update('kind')}>
            <option value="suspended">Suspend booking</option>
            <option value="banned">Ban for good</option>
          </select>
        </div>
        {form.kind === 'suspended' && (
          <div className="field">
            <label htmlFor="r-days">Days</label>
            <input id="r-days" type="number" min="1" max="365" value={form.days} onChange={update('days')} />
          </div>
        )}
        <div className="field">
          <label htmlFor="r-reason">Reason (kept on record)</label>
          <input id="r-reason" value={form.reason} onChange={update('reason')} required minLength={3} />
        </div>
        <button type="submit">Restrict</button>
      </form>
    </section>
  )
}
