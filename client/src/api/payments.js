// Payments (backend step 2b). The browser only STARTS a payment; the result arrives at the
// server later through the provider's signed webhook, so the page then waits for the order
// to leave "pending".
import { api } from './client.js'

// outcome: 'success' | 'failure' — the fake provider's two buttons.
export const startFakePayment = (orderId, outcome) =>
  api(`/payments/fake/${encodeURIComponent(orderId)}`, { method: 'POST', body: { outcome } })

// Razorpay (Phase 7): create (once) the Razorpay order for this order, then report the checkout
// window's answer so the server can check its signature.
export const startRazorpayPayment = (orderId) => api(`/payments/razorpay/${encodeURIComponent(orderId)}`, { method: 'POST' })
export const verifyRazorpayPayment = (orderId, answer) =>
  api(`/payments/razorpay/${encodeURIComponent(orderId)}/verify`, { method: 'POST', body: answer })
