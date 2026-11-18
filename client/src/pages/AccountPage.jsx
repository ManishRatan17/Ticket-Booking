// "My account": who I am, and every device where I'm signed in (backend step A5).
import { useCallback, useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { listSessions, revokeSession } from '../api/auth.js'
import { useAuth } from '../auth/useAuth.js'
import { Alert } from '../components/Alert.jsx'
import { errorMessage } from '../lib/errorMessages.js'
import { describeDevice, formatDate, timeAgo } from '../lib/format.js'

export function AccountPage() {
  const { user, logoutAll } = useAuth()
  const navigate = useNavigate()
  const [sessions, setSessions] = useState(null) // null = still loading
  const [error, setError] = useState(null)
  const [busyId, setBusyId] = useState(null) // which button is working right now

  const load = useCallback(async () => {
    try {
      const { sessions } = await listSessions()
      setSessions(sessions)
      setError(null)
    } catch (err) {
      setError(errorMessage(err))
    }
  }, [])

  // First load. State is set only in the callbacks (see AuthProvider for why).
  useEffect(() => {
    let active = true
    listSessions().then(
      ({ sessions }) => active && setSessions(sessions),
      (err) => active && setError(errorMessage(err)),
    )
    return () => {
      active = false
    }
  }, [])

  async function handleRevoke(id) {
    setBusyId(id)
    try {
      await revokeSession(id) // that device is signed out at once (Redis revocation, step A5)
      await load()
    } catch (err) {
      setError(errorMessage(err))
    } finally {
      setBusyId(null)
    }
  }

  async function handleLogoutAll() {
    // A browser confirm() is plain but honest: this can't be undone.
    if (!window.confirm('Sign out on every device, including this one?')) return
    setBusyId('all')
    try {
      await logoutAll()
      navigate('/login', { replace: true, state: { notice: 'You were signed out on every device.' } })
    } catch (err) {
      setError(errorMessage(err))
      setBusyId(null)
    }
  }

  return (
    <section>
      <h1>My account</h1>

      <div className="panel">
        <dl className="details">
          <dt>Email</dt>
          <dd>{user.email}</dd>
          <dt>Role</dt>
          <dd>{user.role}</dd>
          <dt>Member since</dt>
          <dd>{formatDate(user.createdAt)}</dd>
        </dl>
      </div>

      <h2>Where you're signed in</h2>
      <Alert>{error}</Alert>

      {sessions === null && !error ? (
        <p className="muted">Loading…</p>
      ) : (
        <ul className="session-list">
          {sessions?.map((session) => (
            <li key={session.id} className="panel session">
              <div>
                <strong>{describeDevice(session.userAgent)}</strong>
                {session.current && <span className="badge">This device</span>}
                <p className="muted">
                  Last active {timeAgo(session.lastUsedAt)} · signed in {formatDate(session.createdAt)}
                  {session.ip && ` · ${session.ip}`}
                </p>
              </div>
              {!session.current && (
                <button
                  type="button"
                  className="button button-secondary button-small"
                  disabled={busyId !== null}
                  onClick={() => handleRevoke(session.id)}
                >
                  {busyId === session.id ? 'Signing out…' : 'Sign out'}
                </button>
              )}
            </li>
          ))}
        </ul>
      )}

      <button type="button" className="button button-danger" disabled={busyId !== null} onClick={handleLogoutAll}>
        {busyId === 'all' ? 'Signing out…' : 'Sign out everywhere'}
      </button>
      <p className="muted">
        Do this if you lost a device or think someone else is using your account. To change your password, use{' '}
        <em>Forgot password</em> on the login page.
      </p>
    </section>
  )
}
