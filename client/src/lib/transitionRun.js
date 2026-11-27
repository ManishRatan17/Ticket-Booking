// The timing of one category transition, without React (so it can be tested with fake timers).
//
//   start ──► load() at once, while the animation plays
//   ready  = the data has arrived AND the animation has played for minMs      → onReady(data)
//   maxMs  and still no data  → onPhase('waiting'): the animation stops, a normal loading state shows
//   error  → onPhase('error', error), but never before minMs (the animation isn't cut short);
//            retry() loads again (showing the normal loading state), cancel() stops everything
export function startTransitionRun({ load, minMs, maxMs, onPhase, onReady, setTimer = setTimeout, clearTimer = clearTimeout }) {
  let stopped = false
  let minPassed = false
  let outcome = null // null while loading, then { data } or { error }
  let attempt = 0 // answers from an earlier attempt (before a retry) are ignored
  const timers = []

  function stop() {
    stopped = true
    timers.forEach(clearTimer)
  }

  function settle() {
    if (stopped || !minPassed || !outcome) return
    if (outcome.error) {
      onPhase('error', outcome.error)
      return
    }
    stop()
    onReady(outcome.data)
  }

  function loadNow() {
    const mine = ++attempt
    outcome = null
    Promise.resolve()
      .then(load)
      .then(
        (data) => {
          if (mine !== attempt) return
          outcome = { data }
          settle()
        },
        (error) => {
          if (mine !== attempt) return
          outcome = { error }
          settle()
        },
      )
  }

  timers.push(
    setTimer(() => {
      minPassed = true
      settle()
    }, minMs),
  )
  timers.push(
    setTimer(() => {
      if (!stopped && !outcome) onPhase('waiting')
    }, maxMs),
  )
  loadNow()

  return {
    retry() {
      if (stopped || !outcome?.error) return
      onPhase('waiting')
      loadNow()
    },
    cancel: stop,
  }
}
