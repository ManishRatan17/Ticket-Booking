import { useEffect, useState } from 'react'
import './App.css'

// Only ONE refresh request at a time. In development, React StrictMode runs effects twice;
// two parallel refreshes with the same cookie would collide on the server (409 REFRESH_CONFLICT,
// the "two tabs" case from step A4). Sharing one in-flight promise avoids that.
let refreshInFlight = null
function refreshSession() {
  refreshInFlight ??= fetch('/api/auth/refresh', { method: 'POST' })
    .then((res) => (res.ok ? res.json() : null))
    .finally(() => {
      refreshInFlight = null
    })
  return refreshInFlight
}

// What the server's Google callback put in the URL (?login=...&reason=...).
function readLoginResult() {
  const params = new URLSearchParams(window.location.search)
  const login = params.get('login')
  if (!login) return null
  window.history.replaceState(null, '', window.location.pathname) // tidy the address bar
  if (login === 'failed') return `Google sign-in failed (${params.get('reason')})`
  if (login === 'cancelled') return 'Google sign-in was cancelled'
  return null
}

function App() {
  const [health, setHealth] = useState(null)
  const [error, setError] = useState(null)
  const [user, setUser] = useState(null)
  const [message] = useState(readLoginResult)

  useEffect(() => {
    fetch('/api/health')
      .then((res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        return res.json()
      })
      .then(setHealth)
      .catch((err) => setError(err.message))
  }, [])

  // On page load: ask the server who we are. Both tokens are httpOnly cookies the browser
  // sends by itself — this code never sees them. If the access cookie has expired,
  // refresh once (the refresh cookie gets new ones) and ask again.
  useEffect(() => {
    const getMe = () => fetch('/api/auth/me')
    getMe()
      .then(async (res) => {
        if (res.status === 401 && (await refreshSession())) res = await getMe()
        if (res.ok) setUser((await res.json()).user)
      })
      .catch(() => {})
  }, [])

  return (
    <main className="app">
      <h1>Flash-Sale Tickets</h1>
      <p className="status">
        API status:{' '}
        {error ? (
          <span className="err">unreachable ({error})</span>
        ) : health ? (
          <span className="ok">{health.status}</span>
        ) : (
          'checking…'
        )}
      </p>

      {message && <p className="notice">{message}</p>}

      {user ? (
        <p>
          Signed in as <strong>{user.email}</strong>{' '}
          <button
            type="button"
            onClick={async () => {
              // The refresh cookie tells the server which session to end.
              await fetch('/api/auth/logout', { method: 'POST' })
              setUser(null)
            }}
          >
            Log out
          </button>
        </p>
      ) : (
        // A plain link, not fetch(): the whole browser must travel to Google and back.
        <a className="google-button" href="/api/auth/google">
          Continue with Google
        </a>
      )}
    </main>
  )
}

export default App
