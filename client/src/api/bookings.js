// Bus and train booking (server: modules/bus, modules/train, modules/booking-payments). The two have
// the same shape, so one client serves both: bookingApi('bus') / bookingApi('train').
import { api } from './client.js'

const query = (params) =>
  new URLSearchParams(Object.entries(params).filter(([, v]) => v !== undefined && v !== null && v !== '')).toString()
const id = (value) => encodeURIComponent(value)

export function bookingApi(kind) {
  const base = `/${kind}`
  return {
    routes: () => api(`${base}/routes`),
    search: (params) => api(`${base}/trips?${query(params)}`),
    trip: (tripId) => api(`${base}/trips/${id(tripId)}`),
    // body: bus { seats: ['1A'] } · train { classCode: '3A', travellers: 2 }; the key makes retries safe
    hold: (tripId, body, idempotencyKey) =>
      api(`${base}/trips/${id(tripId)}/holds`, { method: 'POST', body, headers: { 'Idempotency-Key': idempotencyKey } }),
    // the passenger details (a paid trip then waits for payment; a free one is confirmed)
    confirm: (bookingId, body) => api(`${base}/bookings/${id(bookingId)}/confirm`, { method: 'POST', body }),
    cancel: (bookingId) => api(`${base}/bookings/${id(bookingId)}/cancel`, { method: 'POST' }),
    get: (bookingId) => api(`${base}/bookings/${id(bookingId)}`),
    list: () => api(`${base}/bookings`),
    payFake: (bookingId, outcome) => api(`${base}/bookings/${id(bookingId)}/pay/fake`, { method: 'POST', body: { outcome } }),
    payRazorpay: (bookingId) => api(`${base}/bookings/${id(bookingId)}/pay/razorpay`, { method: 'POST' }),
    verifyRazorpay: (bookingId, answer) => api(`${base}/bookings/${id(bookingId)}/pay/razorpay/verify`, { method: 'POST', body: answer }),
  }
}

// Admins: adding trips.
export const adminTrips = (kind) => ({
  list: () => api(`/admin/${kind}/trips`),
  create: (trip) => api(`/admin/${kind}/trips`, { method: 'POST', body: trip }),
})
