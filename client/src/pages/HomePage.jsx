// The landing page: API health (from the original App.jsx) and who's signed in.
import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { api } from '../api/client.js'
import { useAuth } from '../auth/useAuth.js'

export function HomePage() {
  const { status, user } = useAuth()
  const [health, setHealth] = useState(null)
  const [healthError, setHealthError] = useState(null)

  useEffect(() => {
    api('/health')
      .then(setHealth)
      .catch((err) => setHealthError(err.message))
  }, [])

  return (
    <section>
      <h1>Flash-Sale Tickets</h1>
      {status === 'signed-in' ? (
        <p>
          Welcome back, <strong>{user.email}</strong>.
        </p>
      ) : status === 'signed-out' ? (
        <p>
          <Link to="/login">Log in</Link> or <Link to="/register">create an account</Link> to get ready for the next
          sale.
        </p>
      ) : null}

      <p className="status">
        API status:{' '}
        {healthError ? (
          <span className="err">unreachable ({healthError})</span>
        ) : health ? (
          <span className="ok">{health.status}</span>
        ) : (
          'checking…'
        )}
      </p>
    </section>
  )
}
