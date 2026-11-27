// Pure helpers for the bus and train booking pages (tested in booking.test.js).

// Bus seat labels ("1A", "1B", … "10D") → rows for the seat map, with the aisle in the middle:
//   [{ row: 1, left: ['1A', '1B'], right: ['1C', '1D'] }, …]
export function seatRows(labels) {
  const rows = new Map()
  const columns = new Set()
  for (const label of labels) {
    const m = /^(\d+)([A-Z])$/.exec(label)
    if (!m) continue
    const row = Number(m[1])
    columns.add(m[2])
    if (!rows.has(row)) rows.set(row, [])
    rows.get(row).push(label)
  }
  const sortedColumns = [...columns].sort()
  const leftCount = Math.ceil(sortedColumns.length / 2)
  const leftColumns = new Set(sortedColumns.slice(0, leftCount))
  return [...rows.entries()]
    .sort(([a], [b]) => a - b)
    .map(([row, seats]) => {
      const sorted = [...seats].sort()
      return {
        row,
        left: sorted.filter((s) => leftColumns.has(s.slice(-1))),
        right: sorted.filter((s) => !leftColumns.has(s.slice(-1))),
      }
    })
}

// The passenger form's checks, matching the server's (it checks again). Returns { "0.name": "…", … }.
export function passengerErrors(passengers) {
  const errors = {}
  passengers.forEach((p, i) => {
    const name = (p.name ?? '').trim()
    if (name.length < 2) errors[`${i}.name`] = 'At least 2 characters'
    else if (name.length > 60) errors[`${i}.name`] = 'At most 60 characters'
    const age = Number(p.age)
    if (!Number.isInteger(age) || age < 1 || age > 120) errors[`${i}.age`] = 'An age from 1 to 120'
    if (!['female', 'male', 'other'].includes(p.gender)) errors[`${i}.gender`] = 'Choose one'
  })
  return errors
}

export const PHONE = /^\+?[0-9 -]{8,16}$/

// "3h 25m" between two times.
export function duration(from, to) {
  const minutes = Math.max(0, Math.round((new Date(to) - new Date(from)) / 60_000))
  const h = Math.floor(minutes / 60)
  const m = minutes % 60
  return h ? `${h}h ${m}m` : `${m}m`
}

// Tomorrow as YYYY-MM-DD in India (the server's "travel date").
export const tomorrowInIndia = (now = Date.now()) => new Date(now + 86_400_000).toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' })

// The words for a booking's state.
export const BOOKING_STATUS_TEXT = {
  held: 'held, waiting for details and payment',
  confirmed: 'confirmed',
  cancelled: 'cancelled',
  expired: 'expired (not paid in time)',
}

export const CLASS_NAMES = {
  '1A': 'First AC',
  '2A': 'AC 2-tier',
  '3A': 'AC 3-tier',
  SL: 'Sleeper',
  CC: 'AC Chair Car',
  '2S': 'Second Sitting',
}

// "14:05" in India.
export const timeInIndia = (when) => new Date(when).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'Asia/Kolkata' })
