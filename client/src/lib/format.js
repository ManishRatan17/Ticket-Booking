// Small display helpers.

// "Mozilla/5.0 (Windows NT 10.0; Win64; x64) … Chrome/131.0 Safari/537.36"  →  "Chrome on Windows"
// A rough guess for display only. User-Agent strings are sent by the client and can say
// anything, so never use this for security decisions.
export function describeDevice(userAgent) {
  if (!userAgent) return 'Unknown device'
  // Order matters: Edge's string also contains "Chrome", and Chrome's also contains "Safari".
  const browser =
    [
      [/Edg\//, 'Edge'],
      [/OPR\/|Opera/, 'Opera'],
      [/Firefox\//, 'Firefox'],
      [/Chrome\//, 'Chrome'],
      [/Safari\//, 'Safari'],
      [/PostmanRuntime/, 'Postman'],
      [/curl\//, 'curl'],
    ].find(([pattern]) => pattern.test(userAgent))?.[1] ?? 'Unknown browser'
  const os =
    [
      [/Windows/, 'Windows'],
      [/Android/, 'Android'],
      [/iPhone|iPad/, 'iOS'],
      [/Mac OS X/, 'macOS'],
      [/Linux/, 'Linux'],
    ].find(([pattern]) => pattern.test(userAgent))?.[1]
  return os ? `${browser} on ${os}` : browser
}

// "5 minutes ago", "yesterday", "3 days ago" — in the user's own language settings.
export function timeAgo(date, now = Date.now()) {
  const seconds = Math.round((new Date(date).getTime() - now) / 1000)
  const units = [
    ['year', 365 * 24 * 3600],
    ['month', 30 * 24 * 3600],
    ['day', 24 * 3600],
    ['hour', 3600],
    ['minute', 60],
  ]
  const formatter = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' })
  for (const [unit, size] of units) {
    if (Math.abs(seconds) >= size) return formatter.format(Math.round(seconds / size), unit)
  }
  return 'just now'
}

export function formatDate(date) {
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' }).format(new Date(date))
}
