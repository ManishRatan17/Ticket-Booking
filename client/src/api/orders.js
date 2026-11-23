// Orders (backend step 2a).
import { api } from './client.js'

// `idempotencyKey`: a random id made ONCE per checkout attempt and re-sent on every retry of
// that attempt, so a double-click or a retried request returns the same order instead of a second one.
export const createOrder = (holdId, idempotencyKey) =>
  api('/orders', { method: 'POST', body: { holdId }, headers: { 'Idempotency-Key': idempotencyKey } })

export const getOrder = (orderId) => api(`/orders/${encodeURIComponent(orderId)}`)

export const listOrders = () => api('/orders')
