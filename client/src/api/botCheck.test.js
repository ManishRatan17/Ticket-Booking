// Phase 5d: the "are you a person?" token and the honeypot reach the server (fake fetch).
import { test, expect, vi, afterEach } from 'vitest'
import { register } from './auth.js'
import { joinQueue } from './waitingRoom.js'

function fakeFetch() {
  const fetchMock = vi.fn(async () => new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } }))
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}
afterEach(() => vi.unstubAllGlobals())

test('register sends the token in X-Turnstile-Token, and no honeypot field when it is empty', async () => {
  const fetchMock = fakeFetch()
  await register('a@b.co', 'a long password', { botToken: 'tok-1', website: '' })
  const [url, init] = fetchMock.mock.calls[0]
  expect(url).toBe('/api/auth/register')
  expect(init.headers['X-Turnstile-Token']).toBe('tok-1')
  expect(JSON.parse(init.body)).toEqual({ email: 'a@b.co', password: 'a long password' })
})

test('a filled honeypot is sent as it is (the server decides), and no token → no header', async () => {
  const fetchMock = fakeFetch()
  await register('a@b.co', 'a long password', { website: 'http://spam.example' })
  const [, init] = fetchMock.mock.calls[0]
  expect(init.headers['X-Turnstile-Token']).toBeUndefined()
  expect(JSON.parse(init.body).website).toBe('http://spam.example')
})

test('joining a queue sends the token', async () => {
  const fetchMock = fakeFetch()
  await joinQueue(7, 'tok-2')
  const [url, init] = fetchMock.mock.calls[0]
  expect(`${init.method} ${url}`).toBe('POST /api/events/7/queue')
  expect(init.headers['X-Turnstile-Token']).toBe('tok-2')
})
