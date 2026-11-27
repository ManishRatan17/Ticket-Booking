// Opening a category: play its full-screen animation while its data loads, then navigate.
// One transition at a time: while one runs, clicks (double clicks, other cards) are ignored.
import { useCallback, useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { loadCategory } from '../lib/categories.js'
import { errorMessage } from '../lib/errorMessages.js'
import { startTransitionRun } from '../lib/transitionRun.js'

const MIN_MS = 2500 // the animation always plays at least this long
const MAX_MS = 10_000 // after this, it stops and a normal loading state shows

const reducedMotion = () => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false

export function useCategoryTransition() {
  const navigate = useNavigate()
  const [active, setActive] = useState(null) // { category, phase: animating | waiting | error | leaving, error }
  const runRef = useRef(null)
  const exitTimer = useRef(null)

  // Leaving the page mid-transition: stop everything.
  useEffect(
    () => () => {
      runRef.current?.cancel()
      clearTimeout(exitTimer.current)
    },
    [],
  )

  const start = useCallback(
    (category) => {
      if (runRef.current) return
      setActive({ category, phase: 'animating', error: null })
      runRef.current = startTransitionRun({
        load: () => loadCategory(category.key),
        minMs: MIN_MS,
        maxMs: MAX_MS,
        onPhase: (phase, error) => setActive((a) => a && { ...a, phase, error: error ? errorMessage(error) : null }),
        onReady: (data) => {
          setActive((a) => a && { ...a, phase: 'leaving' })
          exitTimer.current = setTimeout(
            () => navigate(category.path, { state: { data } }),
            reducedMotion() ? 0 : category.exitMs, // the fade into the next page (the bus drives off first)
          )
        },
      })
    },
    [navigate],
  )

  const retry = useCallback(() => runRef.current?.retry(), [])

  const cancel = useCallback(() => {
    runRef.current?.cancel()
    runRef.current = null
    clearTimeout(exitTimer.current)
    setActive(null)
  }, [])

  return { active, start, retry, cancel }
}
