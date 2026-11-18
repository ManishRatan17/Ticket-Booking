// Route guards. They improve the EXPERIENCE (no pages you can't use); they are not security.
// Security lives on the server, which checks every request again (401 / 403).
import { Navigate, Outlet, useLocation } from 'react-router-dom'
import { useAuth } from './useAuth.js'

function Loading() {
  return <p className="muted">Loading…</p>
}

// Signed-in users only. Others go to /login, which sends them back here afterwards.
export function RequireAuth() {
  const { status } = useAuth()
  const location = useLocation()
  if (status === 'loading') return <Loading />
  if (status !== 'signed-in') return <Navigate to="/login" replace state={{ from: location.pathname }} />
  return <Outlet />
}

export function RequireAdmin() {
  const { status, user } = useAuth()
  if (status === 'loading') return <Loading />
  if (user?.role !== 'admin') return <Navigate to="/" replace />
  return <Outlet />
}

// Login / register make no sense when already signed in.
export function GuestOnly() {
  const { status } = useAuth()
  if (status === 'loading') return <Loading />
  if (status === 'signed-in') return <Navigate to="/" replace />
  return <Outlet />
}
