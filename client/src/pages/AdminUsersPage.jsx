// Admin → Users: a paged list of every account, and changing roles (backend step A6).
import { useCallback, useEffect, useState } from 'react'
import { changeRole, listUsers, withFreshRole } from '../api/admin.js'
import { useAuth } from '../auth/useAuth.js'
import { Alert } from '../components/Alert.jsx'
import { errorMessage } from '../lib/errorMessages.js'
import { formatDate } from '../lib/format.js'

const PAGE_SIZE = 20

export function AdminUsersPage() {
  const { user: me, reload } = useAuth()
  const [offset, setOffset] = useState(0)
  const [page, setPage] = useState(null) // { users, total, limit, offset }
  const [error, setError] = useState(null)
  const [notice, setNotice] = useState(null)
  const [busyId, setBusyId] = useState(null)

  const load = useCallback(async (at) => {
    try {
      setPage(await withFreshRole(() => listUsers({ limit: PAGE_SIZE, offset: at })))
      setError(null)
    } catch (err) {
      setError(errorMessage(err))
    }
  }, [])

  // Load whenever the page number changes (state set only in the callbacks).
  useEffect(() => {
    let active = true
    withFreshRole(() => listUsers({ limit: PAGE_SIZE, offset })).then(
      (result) => active && setPage(result),
      (err) => active && setError(errorMessage(err)),
    )
    return () => {
      active = false
    }
  }, [offset])

  async function handleRoleChange(target, role) {
    const isSelf = target.id === me.id
    if (role === 'user') {
      const who = isSelf ? 'yourself' : target.email
      const ok = window.confirm(
        `Remove admin rights from ${who}? ` +
          `${isSelf ? 'You' : 'They'} will be signed out on every device immediately.`,
      )
      if (!ok) return
    }

    setBusyId(target.id)
    setNotice(null)
    try {
      await withFreshRole(() => changeRole(target.id, role))
      if (isSelf) {
        // Demoting yourself ended your own sessions on the server. Ask who we are now:
        // the app notices we're signed out and the admin page closes.
        await reload()
        return
      }
      setNotice(
        role === 'admin'
          ? `${target.email} is now an admin (from their next token refresh, at most 15 minutes).`
          : `${target.email} is no longer an admin and was signed out everywhere.`,
      )
      await load(offset)
    } catch (err) {
      setError(errorMessage(err))
    } finally {
      setBusyId(null)
    }
  }

  const first = page && page.total > 0 ? page.offset + 1 : 0
  const last = page ? page.offset + page.users.length : 0

  return (
    <section>
      <h1>Users</h1>
      <Alert>{error}</Alert>
      <Alert kind="success">{notice}</Alert>

      {!page && !error ? (
        <p className="muted">Loading…</p>
      ) : page ? (
        <>
          <p className="muted">
            Showing {first}–{last} of {page.total}
          </p>
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Email</th>
                  <th>Sign-in</th>
                  <th>Joined</th>
                  <th>Role</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {page.users.map((user) => (
                  <tr key={user.id}>
                    <td>
                      {user.email}
                      {user.id === me.id && <span className="muted"> (you)</span>}
                    </td>
                    <td>
                      {[user.hasPassword && 'Password', user.hasGoogle && 'Google'].filter(Boolean).join(' + ') || '—'}
                    </td>
                    <td>{formatDate(user.createdAt)}</td>
                    <td>{user.role === 'admin' ? <span className="badge">admin</span> : 'user'}</td>
                    <td>
                      <button
                        type="button"
                        className="button button-secondary button-small"
                        disabled={busyId !== null}
                        onClick={() => handleRoleChange(user, user.role === 'admin' ? 'user' : 'admin')}
                      >
                        {busyId === user.id ? 'Saving…' : user.role === 'admin' ? 'Remove admin' : 'Make admin'}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="pager">
            <button
              type="button"
              className="button button-secondary button-small"
              disabled={offset === 0}
              onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))}
            >
              ← Previous
            </button>
            <button
              type="button"
              className="button button-secondary button-small"
              disabled={last >= page.total}
              onClick={() => setOffset(offset + PAGE_SIZE)}
            >
              Next →
            </button>
          </div>
        </>
      ) : null}
    </section>
  )
}
