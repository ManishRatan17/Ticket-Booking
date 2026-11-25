// The Razorpay calls go to the right place with the right body (fake fetch).
import { test, expect, vi, afterEach } from 'vitest'
import { startRazorpayPayment, verifyRazorpayPayment } from './payments.js'

afterEach(() => vi.unstubAllGlobals())

test('start → POST /api/payments/razorpay/:id; verify sends Razorpay\'s answer as it is', async () => {
  const fetchMock = vi.fn(async () => new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } }))
  vi.stubGlobal('fetch', fetchMock)
  await startRazorpayPayment(42)
  const answer = { razorpay_order_id: 'order_1', razorpay_payment_id: 'pay_1', razorpay_signature: 'abc' }
  await verifyRazorpayPayment(42, answer)
  const [[url1, init1], [url2, init2]] = fetchMock.mock.calls
  expect(`${init1.method} ${url1}`).toBe('POST /api/payments/razorpay/42')
  expect(`${init2.method} ${url2}`).toBe('POST /api/payments/razorpay/42/verify')
  expect(JSON.parse(init2.body)).toEqual(answer)
})
