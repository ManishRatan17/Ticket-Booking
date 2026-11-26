// The frame around every page: navigation bar, Google sign-in result, then the page itself.
import { useEffect, useState } from 'react'
import { Link, NavLink, Outlet, useNavigate, useSearchParams } from 'react-router-dom'
import { RestrictionBanner } from './RestrictionBanner.jsx'
import { RestrictionsLink } from './RestrictionsLink.jsx'
import { useAuth } from '../auth/useAuth.js'
import { Alert } from './Alert.jsx'
import { errorMessage } from '../lib/errorMessages.js'

function NavBar() {
  const { status, user, logout } = useAuth()
  const navigate = useNavigate()

  async function handleLogout() {
    await logout()
    navigate('/login')
  }

  return (
    <header className="navbar">
      <Link to="/" className="brand">
        Flash-Sale Tickets
      </Link>
      <nav>
        <NavLink to="/events">Events</NavLink>
        {status === 'signed-in' ? (
          <>
            {/* Admins run the sale, they don't buy or ask for help (the server refuses it too). */}
            {user.role === 'admin' ? (
              <>
                <NavLink to="/admin/events">Manage events</NavLink>
                <NavLink to="/admin/support">Support inbox</NavLink>
                <NavLink to="/admin/refunds">Refunds</NavLink>
                <RestrictionsLink />
                <NavLink to="/admin/users">Users</NavLink>
                <NavLink to="/admin/system">System</NavLink>
                <NavLink to="/admin/audit">Audit log</NavLink>
              </>
            ) : (
              <>
                <NavLink to="/orders">My orders</NavLink>
                <NavLink to="/support">Help</NavLink>
              </>
            )}
            <NavLink to="/account" title="My account and devices">
              {user.email}
            </NavLink>
            <button type="button" className="button-link" onClick={handleLogout}>
              Log out
            </button>
          </>
        ) : status === 'signed-out' ? (
          <>
            <NavLink to="/login">Log in</NavLink>
            <NavLink to="/register">Register</NavLink>
          </>
        ) : null}
      </nav>
    </header>
  )
}

// After Google, the server redirects to /?login=google | cancelled | failed&reason=CODE.
function readGoogleResult(params) {
  const login = params.get('login')
  if (login === 'failed') return { kind: 'error', text: errorMessage(params.get('reason')) }
  if (login === 'cancelled') return { kind: 'info', text: 'Google sign-in was cancelled.' }
  return null // 'google' = success: the signed-in user appears by itself
}

// Coming back from Google is a full page load, so the Layout is created fresh: read the
// result ONCE when it's created, then tidy the address bar.
function GoogleResult() {
  const [params, setParams] = useSearchParams()
  const [result] = useState(() => readGoogleResult(params))
  const hasLoginParam = params.has('login')

  useEffect(() => {
    if (hasLoginParam) setParams({}, { replace: true })
  }, [hasLoginParam, setParams])

  return result && <Alert kind={result.kind}>{result.text}</Alert>
}

export function Layout() {
  const { user } = useAuth() // for the "account restricted" banner on every page (Phase 5e)
  return (
    <>
      <NavBar />
      <main className="app">
        <GoogleResult />
        <RestrictionBanner restriction={user?.restriction} />
        <Outlet />
      </main>
    </>
  )
}
