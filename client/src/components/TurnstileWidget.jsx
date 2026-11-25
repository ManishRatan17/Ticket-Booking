// Cloudflare Turnstile, the "are you a person?" check (Phase 5d).
// Loads Cloudflare's script once, draws the widget into a box, and hands the token to onToken.
// The token is single-use and expires after 5 minutes: when it expires, onToken(null).
// To get a FRESH token (after it was used), the parent re-mounts this with a new `key`.
import { useEffect, useRef, useState } from 'react'

const SCRIPT_URL = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit'
let loading = null // one <script> for the whole app

function loadTurnstile() {
  loading ??= new Promise((resolve, reject) => {
    const script = document.createElement('script')
    script.src = SCRIPT_URL
    script.async = true
    script.onload = () => resolve(window.turnstile)
    script.onerror = () => {
      loading = null // allow a retry later
      reject(new Error('Turnstile script failed to load'))
    }
    document.head.appendChild(script)
  })
  return loading
}

export function TurnstileWidget({ siteKey, onToken }) {
  const box = useRef(null)
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    let active = true
    let widgetId = null
    loadTurnstile().then(
      (turnstile) => {
        if (!active) return
        widgetId = turnstile.render(box.current, {
          sitekey: siteKey,
          callback: (token) => onToken(token),
          'expired-callback': () => onToken(null),
          'error-callback': () => onToken(null),
        })
      },
      () => active && setFailed(true),
    )
    return () => {
      active = false
      if (widgetId !== null) window.turnstile?.remove(widgetId)
    }
  }, [siteKey, onToken])

  if (failed) {
    return <p className="muted">The &ldquo;are you a person?&rdquo; check could not load. Check your connection and reload.</p>
  }
  return <div ref={box} className="human-check" />
}
