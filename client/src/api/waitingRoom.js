// Waiting room (backend Phase 4).
import { api } from './client.js'

export const joinQueue = (eventId) => api(`/events/${encodeURIComponent(eventId)}/queue`, { method: 'POST' })

export const getQueueStatus = (eventId) => api(`/events/${encodeURIComponent(eventId)}/queue`)

// Server-Sent Events: the browser's EventSource opens this and receives updates by itself.
export const queueStreamUrl = (eventId) => `/api/events/${encodeURIComponent(eventId)}/queue/stream`
