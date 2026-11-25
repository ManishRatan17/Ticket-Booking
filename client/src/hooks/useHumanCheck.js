import { useCallback, useEffect, useState } from 'react'
import { getPublicConfig } from '../api/config.js'

// State for the "are you a person?" check on one form (Phase 5d).
//   siteKey  undefined = still asking the server · null = the check is off · string = show the widget
//   token    the one-time token from the widget, or null
//   ready    true when the form may be sent (check off, or a token in hand)
//   round    use as the widget's `key`; reset() bumps it to get a fresh widget (tokens are single-use)
export function useHumanCheck() {
  const [siteKey, setSiteKey] = useState(undefined)
  const [token, setToken] = useState(null)
  const [round, setRound] = useState(0)

  useEffect(() => {
    let active = true
    getPublicConfig().then(
      (config) => active && setSiteKey(config.botCheck?.siteKey ?? null),
      () => active && setSiteKey(null), // can't ask: let the SERVER decide (it answers 403 if needed)
    )
    return () => {
      active = false
    }
  }, [])

  const reset = useCallback(() => {
    setToken(null)
    setRound((r) => r + 1)
  }, [])

  return { siteKey, token, setToken, ready: siteKey === null || Boolean(token), round, reset }
}
