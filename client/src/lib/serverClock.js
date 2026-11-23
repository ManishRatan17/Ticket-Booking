// Countdowns that don't trust the user's clock.
//
// The server sends `serverTime` (from Redis's clock — the same clock that set every
// `expiresAt`). We remember how far THIS device's clock is from it:
//
//   offset = serverTime − (this device's time when the answer arrived)
//
// and from then on "server now" = this device's now + offset. A laptop whose clock is 3 minutes
// fast still shows the right time left. (Network delay adds a small error, well under a second.)

export function clockOffset(serverTime, receivedAt = Date.now()) {
  return new Date(serverTime).getTime() - receivedAt
}

// Whole seconds from "server now" until `target` (never negative).
export function secondsUntil(target, offsetMs, now = Date.now()) {
  const ms = new Date(target).getTime() - (now + offsetMs)
  return Math.max(0, Math.ceil(ms / 1000))
}

// 299 → "4:59",  3725 → "1:02:05"
export function formatCountdown(totalSeconds) {
  const h = Math.floor(totalSeconds / 3600)
  const m = Math.floor((totalSeconds % 3600) / 60)
  const s = totalSeconds % 60
  const pad = (n) => String(n).padStart(2, '0')
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`
}
