// Admin endpoints (backend steps A6 and 4b). The server allows these only for role "admin".
import { api, refreshSession } from './client.js'

export const listUsers = ({ limit, offset }) =>
  api(`/admin/users?${new URLSearchParams({ limit: String(limit), offset: String(offset) })}`)

export const changeRole = (userId, role) =>
  api(`/admin/users/${encodeURIComponent(userId)}/role`, { method: 'PATCH', body: { role } })

// Sends EVERY field of the form (price, waiting room, lobby, lucky draw …). It used to pick only
// name/totalTickets/saleStartsAt, which silently dropped the rest; the server validates the body.
export const createEvent = (event) => api('/admin/events', { method: 'POST', body: event })

// Background jobs (Phase 3): counts, workers, schedules, failed jobs (dead-letter queue).
export const getJobsOverview = () => api('/admin/jobs')

export const retryJob = (jobId) => api(`/admin/jobs/${encodeURIComponent(jobId)}/retry`, { method: 'POST' })

// Manage events: every event with live numbers, one event, edit.
export const listAdminEvents = () => api('/admin/events')
export const getAdminEvent = (id) => api(`/admin/events/${encodeURIComponent(id)}`)
export const updateEvent = (id, changes) => api(`/admin/events/${encodeURIComponent(id)}`, { method: 'PATCH', body: changes })
// Cancel: stops the sale, refunds every paid order, emails ticket holders. Can't be undone.
export const cancelEvent = (id, reason) => api(`/admin/events/${encodeURIComponent(id)}/cancel`, { method: 'POST', body: { reason } })

// Refunds: list (pending first) and retry a pending one.
export const listRefunds = (status) => api(`/admin/refunds${status ? `?status=${encodeURIComponent(status)}` : ''}`)
export const retryRefund = (id) => api(`/admin/refunds/${encodeURIComponent(id)}/retry`, { method: 'POST' })

// The audit log (read-only).
export const listAudit = (action) => api(`/admin/audit${action ? `?action=${encodeURIComponent(action)}` : ''}`)

// Notifications: new automatic restrictions (bot strikes) no admin has seen yet.
export const getNotifications = () => api('/admin/notifications')
export const acknowledgeRestrictions = () => api('/admin/restrictions/acknowledge', { method: 'POST' })

// Restrictions (Phase 5e: bot strikes).
export const listRestrictions = (activeOnly) => api(`/admin/restrictions?active=${activeOnly ? 'true' : 'false'}`)
export const restrictUser = (body) => api('/admin/restrictions', { method: 'POST', body })
export const liftRestriction = (id, { reason, overturn }) =>
  api(`/admin/restrictions/${encodeURIComponent(id)}/lift`, { method: 'POST', body: { reason, overturn } })

// The admin API checks the role inside the ACCESS TOKEN, which was made at the last refresh.
// Someone promoted a moment ago still holds a token that says "user" → 403. One refresh gets a
// token with the role from the database (A6: "promotion takes effect at the next refresh").
export async function withFreshRole(request) {
  try {
    return await request()
  } catch (err) {
    if (err.code === 'FORBIDDEN' && (await refreshSession())) return request()
    throw err
  }
}
