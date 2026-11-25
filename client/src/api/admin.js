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
