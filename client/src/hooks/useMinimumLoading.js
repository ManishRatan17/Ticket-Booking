import { useEffect, useRef, useState } from 'react'

// Keeps a loading state active for at least `minDurationMs` (so fast responses
// don't flicker), while continuing to return `true` if `isLoading` takes longer.
export function useMinimumLoading(isLoading, minDurationMs = 1500) {
  const [minActive, setMinActive] = useState(isLoading)
  const timerRef = useRef(null)

  useEffect(() => {
    if (isLoading) {
      clearTimeout(timerRef.current)
      const activate = setTimeout(() => setMinActive(true), 0)
      timerRef.current = setTimeout(() => {
        setMinActive(false)
        timerRef.current = null
      }, minDurationMs)
      return () => clearTimeout(activate)
    }
  }, [isLoading, minDurationMs])

  useEffect(() => {
    return () => clearTimeout(timerRef.current)
  }, [])

  return isLoading || minActive
}
