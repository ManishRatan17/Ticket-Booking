import { useEffect, useState } from 'react'
import { secondsUntil } from '../lib/serverClock.js'

// Seconds left until `target` on the SERVER's clock, updated every second.
// Calls onFinished() once when it reaches 0 (e.g. to ask the server what happened).
//
// Only "now" is kept in state; the seconds left are CALCULATED from it during render.
// (Storing both would mean keeping two pieces of state in sync — a classic source of bugs.)
export function useCountdown(target, offsetMs, onFinished) {
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    if (!target) return undefined
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer) // stop ticking when the page closes or the target changes
  }, [target])

  const left = target ? secondsUntil(target, offsetMs, now) : 0

  useEffect(() => {
    if (target && left === 0) onFinished?.()
  }, [target, left, onFinished])

  return left
}
