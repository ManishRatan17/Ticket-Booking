// Tests for the API client's trickiest logic, with a FAKE fetch (no server needed).
import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest'
import { api, ApiError, onSessionEnded } from './client.js'

// A tiny fake server: each call to fetch() takes the next scripted response.
function script(...responses) {
  const fetchMock = vi.fn(async () => {
    const next = responses.shift()
    if (!next) throw new Error('fetch called more times than scripted')
    return new Response(next.body === undefined ? null : JSON.stringify(next.body), {
      status: next.status,
      headers: { 'Content-Type': 'application/json', ...next.headers },
    })
  })
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

const expired = { status: 401, body: { error: { code: 'TOKEN_EXPIRED', message: 'expired' } } }
const noCookie = { status: 401, body: { error: { code: 'AUTH_REQUIRED', message: 'no cookie' } } }
const ok = (body) => ({ status: 200, body })
const urls = (fetchMock) => fetchMock.mock.calls.map(([url, init]) => `${init?.method ?? 'GET'} ${url}`)

beforeEach(() => vi.useRealTimers())
afterEach(() => vi.unstubAllGlobals())

describe('happy paths', () => {
  test('GET returns the parsed JSON', async () => {
    script(ok({ user: { id: 1 } }))
    expect(await api('/auth/me')).toEqual({ user: { id: 1 } })
  })

  test('POST sends JSON with the right header', async () => {
    const fetchMock = script(ok({}))
    await api('/auth/login', { method: 'POST', body: { email: 'a@b.co' } })
    const [, init] = fetchMock.mock.calls[0]
    expect(init.headers).toEqual({ 'Content-Type': 'application/json' })
    expect(JSON.parse(init.body)).toEqual({ email: 'a@b.co' })
  })

  test('204 No Content returns null', async () => {
    script({ status: 204 })
    expect(await api('/auth/logout', { method: 'POST' })).toBeNull()
  })
})

describe('automatic refresh', () => {
  test('expired access cookie → refresh once → retry → success', async () => {
    const fetchMock = script(expired, ok({ expiresIn: 900 }), ok({ user: { id: 1 } }))
    expect(await api('/auth/me')).toEqual({ user: { id: 1 } })
    expect(urls(fetchMock)).toEqual(['GET /api/auth/me', 'POST /api/auth/refresh', 'GET /api/auth/me'])
  })

  test('missing access cookie (AUTH_REQUIRED) is refreshed the same way', async () => {
    const fetchMock = script(noCookie, ok({ expiresIn: 900 }), ok({ ok: true }))
    await api('/auth/sessions')
    expect(fetchMock).toHaveBeenCalledTimes(3)
  })

  test('3 requests expire at the same moment → only ONE refresh request', async () => {
    const fetchMock = vi.fn(async (url) => {
      if (url === '/api/auth/refresh') {
        await new Promise((resolve) => setTimeout(resolve, 20))
        return new Response(JSON.stringify({ expiresIn: 900 }), { status: 200 })
      }
      const refreshed = fetchMock.mock.calls.some(([u]) => u === '/api/auth/refresh')
      return refreshed
        ? new Response(JSON.stringify({ url }), { status: 200 })
        : new Response(JSON.stringify(expired.body), { status: 401 })
    })
    vi.stubGlobal('fetch', fetchMock)

    await Promise.all([api('/a'), api('/b'), api('/c')])
    const refreshCalls = fetchMock.mock.calls.filter(([u]) => u === '/api/auth/refresh')
    expect(refreshCalls).toHaveLength(1)
  })

  test('409 REFRESH_CONFLICT (another tab refreshed) counts as refreshed', async () => {
    const conflict = { status: 409, body: { error: { code: 'REFRESH_CONFLICT', message: 'x' } } }
    const fetchMock = script(expired, conflict, ok({ user: { id: 1 } }))
    expect(await api('/auth/me')).toEqual({ user: { id: 1 } })
    expect(fetchMock).toHaveBeenCalledTimes(3)
  })

  test('refresh fails → ApiError thrown AND "session ended" listeners told', async () => {
    script(expired, { status: 401, body: { error: { code: 'SESSION_REVOKED', message: 'gone' } } })
    const listener = vi.fn()
    const stop = onSessionEnded(listener)
    await expect(api('/auth/me')).rejects.toMatchObject({ status: 401, code: 'TOKEN_EXPIRED' })
    expect(listener).toHaveBeenCalledOnce()
    stop()
  })

  test('retries only ONCE: still 401 after a successful refresh → error, no loop', async () => {
    const fetchMock = script(expired, ok({ expiresIn: 900 }), expired)
    await expect(api('/auth/me')).rejects.toBeInstanceOf(ApiError)
    expect(fetchMock).toHaveBeenCalledTimes(3)
  })

  test('other 401s (wrong password, revoked session) are NOT refreshed', async () => {
    const fetchMock = script({ status: 401, body: { error: { code: 'INVALID_CREDENTIALS', message: 'no' } } })
    await expect(api('/auth/login', { method: 'POST', body: {} })).rejects.toMatchObject({
      code: 'INVALID_CREDENTIALS',
    })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})

describe('errors', () => {
  test('server error format → ApiError with code, message and field details', async () => {
    const details = [{ field: 'body.email', message: 'Invalid email address' }]
    script({ status: 400, body: { error: { code: 'VALIDATION_ERROR', message: 'Request validation failed', details } } })
    await expect(api('/auth/register', { method: 'POST', body: {} })).rejects.toMatchObject({
      status: 400,
      code: 'VALIDATION_ERROR',
      details,
    })
  })

  test('429 → retryAfterSeconds from the Retry-After header', async () => {
    script({ status: 429, headers: { 'Retry-After': '120' }, body: { error: { code: 'RATE_LIMITED', message: 'slow down' } } })
    await expect(api('/auth/login', { method: 'POST', body: {} })).rejects.toMatchObject({
      code: 'RATE_LIMITED',
      retryAfterSeconds: 120,
    })
  })

  test('a response that is not JSON still becomes a clean ApiError', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('<html>Bad Gateway</html>', { status: 502 })))
    await expect(api('/health')).rejects.toMatchObject({ status: 502, code: 'HTTP_ERROR' })
  })
})
