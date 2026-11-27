// The frame around every page: the navigation bar (a ☰ menu on phones), the admin sidebar on /admin
// pages, the Google sign-in result, the page itself, and the footer.
import { useEffect, useState } from 'react'
import { Link, NavLink, Outlet, useLocation, useNavigate, useSearchParams } from 'react-router-dom'
import { RestrictionBanner } from './RestrictionBanner.jsx'
import { RestrictionsLink } from './RestrictionsLink.jsx'
import { useAuth } from '../auth/useAuth.js'
import { Alert } from './Alert.jsx'
import { errorMessage } from '../lib/errorMessages.js'

// Admin pages, in the sidebar (admins run the sale: they don't buy or ask for help; the server refuses it too).
const ADMIN_LINKS = [
  { to: '/admin/events', label: 'Manage events', icon: '🎟' },
  { to: '/admin/trips', label: 'Trips', icon: '🚆' },
  { to: '/admin/support', label: 'Support inbox', icon: '💬' },
  { to: '/admin/refunds', label: 'Refunds', icon: '↩️' },
  { restrictions: true, icon: '🛡' },
  { to: '/admin/users', label: 'Users', icon: '👥' },
  { to: '/admin/system', label: 'System', icon: '⚙️' },
  { to: '/admin/audit', label: 'Audit log', icon: '📜' },
]

function NavBar() {
  const { status, user, logout } = useAuth()
  const navigate = useNavigate()
  const location = useLocation()
  const [open, setOpen] = useState(false) // the phone menu
  const [openedAt, setOpenedAt] = useState(location.pathname)
  // Close the phone menu when the page changes (state adjusted during render, no effect needed).
  if (openedAt !== location.pathname) {
    setOpenedAt(location.pathname)
    setOpen(false)
  }

  async function handleLogout() {
    await logout()
    navigate('/login')
  }

  const initial = user?.email?.[0]?.toUpperCase() ?? '?'
  return (
    <header className="navbar">
      <div className="navbar__inner">
        <Link to="/" className="brand">
          <span className="brand__mark" aria-hidden="true">
            🎫
          </span>
          <span className="brand__name">Flash-Sale Tickets</span>
        </Link>
        <button
          type="button"
          className="navbar__toggle"
          aria-expanded={open}
          aria-controls="main-nav"
          aria-label={open ? 'Close the menu' : 'Open the menu'}
          onClick={() => setOpen(!open)}
        >
          {open ? '✕' : '☰'}
        </button>
        <nav id="main-nav" className={open ? 'navbar__nav is-open' : 'navbar__nav'}>
          <NavLink to="/" end>
            Home
          </NavLink>
          <NavLink to="/events">Events</NavLink>
          {status === 'signed-in' ? (
            <>
              {user.role === 'admin' ? (
                <NavLink to="/admin/events" className={() => (location.pathname.startsWith('/admin') ? 'active' : undefined)}>
                  Admin
                </NavLink>
              ) : (
                <>
                  <NavLink to="/orders">My bookings</NavLink>
                  <NavLink to="/support">Help</NavLink>
                </>
              )}
              <NavLink to="/account" className={({ isActive }) => `user-chip${isActive ? ' active' : ''}`} title="My account and devices">
                <span className="user-chip__avatar" aria-hidden="true">
                  {initial}
                </span>
                <span className="user-chip__email">{user.email}</span>
              </NavLink>
              <button type="button" className="button button-secondary button-small" onClick={handleLogout}>
                Log out
              </button>
            </>
          ) : status === 'signed-out' ? (
            <>
              <NavLink to="/login">Log in</NavLink>
              <Link to="/register" className="button button-small">
                Register
              </Link>
            </>
          ) : null}
        </nav>
      </div>
    </header>
  )
}

function AdminSidebar() {
  return (
    <aside className="admin-sidebar" aria-label="Admin">
      <p className="admin-sidebar__title">Admin</p>
      <nav>
        {ADMIN_LINKS.map((l) =>
          l.restrictions ? (
            <RestrictionsLink key="restrictions" icon={l.icon} />
          ) : (
            <NavLink key={l.to} to={l.to}>
              <span aria-hidden="true">{l.icon}</span> {l.label}
            </NavLink>
          ),
        )}
      </nav>
    </aside>
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
  const location = useLocation()
  const adminArea = user?.role === 'admin' && location.pathname.startsWith('/admin')
  const page = (
    <main className={adminArea ? 'app app--admin' : 'app'} key={location.pathname}>
      <GoogleResult />
      <RestrictionBanner restriction={user?.restriction} />
      <Outlet />
    </main>
  )
  return (
    <div className="shell">
      <NavBar />
      {adminArea ? (
        <div className="admin-shell">
          <AdminSidebar />
          {page}
        </div>
      ) : (
        page
      )}
      <footer className="footer">
        <p>
          <strong>Flash-Sale Tickets</strong> · Trains, buses, movies and flights · Fair, fast, bot-proof
        </p>
        <p className="footer__links">
          <Link to="/events">Events</Link>
          <Link to="/book/train">Trains</Link>
          <Link to="/book/bus">Buses</Link>
          <Link to="/support">Help</Link>
        </p>
      </footer>
    </div>
  )
}
