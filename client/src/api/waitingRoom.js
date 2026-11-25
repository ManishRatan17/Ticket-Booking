// Waiting room (backend Phase 4).
import { api } from './client.js'

// botToken: from the "are you a person?" widget (Phase 5d).
export const joinQueue = (eventId, botToken) =>
  api(`/events/${encodeURIComponent(eventId)}/queue`, {
    method: 'POST',
    headers: botToken ? { 'X-Turnstile-Token': botToken } : {},
  })

export const getQueueStatus = (eventId) => api(`/events/${encodeURIComponent(eventId)}/queue`)

// Server-Sent Events: the browser's EventSource opens this and receives updates by itself.
export const queueStreamUrl = (eventId) => `/api/events/${encodeURIComponent(eventId)}/queue/stream`
