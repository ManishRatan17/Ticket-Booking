// The support inbox (server: modules/support). People ask; admins answer and decide.
import { api } from './client.js'

const id = (value) => encodeURIComponent(value)

// kind 'more_tickets' needs eventId + extraTickets (1–4); kind 'question' may name an event.
export const createRequest = (request) => api('/support/requests', { method: 'POST', body: request })
export const listMyRequests = () => api('/support/requests')
export const getMyRequest = (requestId) => api(`/support/requests/${id(requestId)}`)
export const sendMessage = (requestId, body) =>
  api(`/support/requests/${id(requestId)}/messages`, { method: 'POST', body: { body } })

// Admins
export const listSupport = (status) => api(`/admin/support${status ? `?status=${id(status)}` : ''}`)
export const getSupport = (requestId) => api(`/admin/support/${id(requestId)}`)
export const replySupport = (requestId, body) =>
  api(`/admin/support/${id(requestId)}/messages`, { method: 'POST', body: { body } })
// decision: 'approved' | 'declined' (more tickets) · 'closed' (anything)
export const decideSupport = (requestId, decision, message) =>
  api(`/admin/support/${id(requestId)}/decision`, { method: 'POST', body: message ? { decision, message } : { decision } })
