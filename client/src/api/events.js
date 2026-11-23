// Events and ticket holds (backend step 4b).
import { api } from './client.js'

export const listEvents = () => api('/events')

export const getEvent = (eventId) => api(`/events/${encodeURIComponent(eventId)}`)

export const holdTickets = (eventId, quantity) =>
  api(`/events/${encodeURIComponent(eventId)}/holds`, { method: 'POST', body: { quantity } })

export const getMyHold = (eventId) => api(`/events/${encodeURIComponent(eventId)}/holds/mine`)

export const releaseHold = (holdId) => api(`/holds/${encodeURIComponent(holdId)}`, { method: 'DELETE' })

// The most tickets one person may hold (the server enforces the same limit).
export const MAX_TICKETS_PER_HOLD = 4
