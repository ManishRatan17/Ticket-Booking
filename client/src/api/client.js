// The ONLY place in the frontend that calls fetch().
//
// It never sees a token: both tokens are httpOnly cookies that the browser stores and
// sends by itself. Its jobs are:
//   1. send/receive JSON
//   2. when the access cookie has expired (401), refresh ONCE and retry the request
//   3. turn the server's { error: { code, message, details } } into an ApiError

export class ApiError extends Error {
  constructor({ status, code, message, details, retryAfterSeconds }) {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.code = code // stable, for programs: 'EMAIL_TAKEN', 'RATE_LIMITED', …
    this.details = details // e.g. [{ field: 'body.password', message: '…' }]
    this.retryAfterSeconds = retryAfterSeconds // set on 429 responses
  }
}

// 401 codes that mean "your access cookie is missing or expired" — fixable by refreshing.
// Any other 401 (wrong password, revoked session…) is final.
const REFRESHABLE = new Set(['AUTH_REQUIRED', 'TOKEN_EXPIRED'])

// Called when refreshing fails, i.e. the session is really over (AuthContext listens).
const sessionEndedListeners = new Set()
export function onSessionEnded(listener) {
  sessionEndedListeners.add(listener)
  return () => sessionEndedListeners.delete(listener)
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

// ONE refresh at a time, shared by everyone. If 5 requests all get 401 at once, they all
// wait for the same single POST /refresh. Five parallel refreshes with the same cookie
// would trip the server's "two tabs" protection (409) — see step A4.
let refreshInFlight = null
export function refreshSession() {
  refreshInFlight ??= doRefresh().finally(() => {
    refreshInFlight = null
  })
  return refreshInFlight
}

async function doRefresh() {
  const res = await fetch('/api/auth/refresh', { method: 'POST' })
  if (res.ok) return true
  if (res.status === 409) {
    // ANOTHER TAB refreshed a moment ago and its response is putting the new cookies in this
    // same browser. Give it a moment to land, then carry on with those.
    await sleep(250)
    return true
  }
  return false
}

async function toApiError(res) {
  const body = await res.json().catch(() => ({}))
  const error = body.error ?? {}
  const retryAfter = Number(res.headers.get('retry-after'))
  return new ApiError({
    status: res.status,
    code: error.code ?? 'HTTP_ERROR',
    message: error.message ?? `Request failed (${res.status})`,
    details: error.details,
    retryAfterSeconds: Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : undefined,
  })
}

// api('/auth/me')                                  → GET, returns parsed JSON
// api('/auth/login', { method: 'POST', body: {…} })
export async function api(path, { method = 'GET', body, retryOnExpiry = true } = {}) {
  const res = await fetch(`/api${path}`, {
    method,
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })

  if (res.ok) return res.status === 204 ? null : res.json()

  const error = await toApiError(res)

  if (res.status === 401 && retryOnExpiry && REFRESHABLE.has(error.code)) {
    if (await refreshSession()) {
      return api(path, { method, body, retryOnExpiry: false }) // retry ONCE, never loop
    }
    sessionEndedListeners.forEach((listener) => listener())
  }
  throw error
}
