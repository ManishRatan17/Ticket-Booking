import { useCallback, useEffect, useState } from 'react'
import { getQueueStatus, joinQueue, queueStreamUrl } from '../api/waitingRoom.js'

// Entered in a lucky draw that hasn't picked you yet: keep listening, the result comes live.
const waitingForDraw = (s) => Boolean(s.lottery && s.lottery.state !== 'closed' && s.lottery.entered && !s.lottery.won)

// Your place in an event's waiting room, kept up to date LIVE.
//
//   1. Ask once (GET) where you are.
//   2. If you're waiting (or in the lobby): open a Server-Sent Events stream — the server pushes every change.
//   3. If the stream breaks (network, or your access cookie expired — EventSource can't refresh
//      it), fall back to asking every 2 s through the API client, which DOES refresh.
//
// Returns { status, join }. status is null while loading.
export function useQueueStatus(eventId, enabled) {
  const [status, setStatus] = useState(null)
  const [version, setVersion] = useState(0) // bumped after joining, to (re)connect

  useEffect(() => {
    if (!enabled) return undefined
    let active = true
    let source = null
    let poller = null

    const apply = (next) => {
      if (!active) return
      setStatus(next)
      if ((next.status === 'admitted' && !waitingForDraw(next)) || next.chance === 'sold_out') {
        source?.close() // nothing more to wait for
        clearInterval(poller)
      }
    }
    const startPolling = () => {
      poller ??= setInterval(() => getQueueStatus(eventId).then(apply, () => {}), 2000)
    }
    const openStream = () => {
      source = new EventSource(queueStreamUrl(eventId)) // same origin: our cookies go along
      source.addEventListener('status', (message) => apply(JSON.parse(message.data)))
      source.onerror = () => {
        source.close()
        if (active) startPolling()
      }
    }

    getQueueStatus(eventId).then(
      (first) => {
        apply(first)
        if (active && (first.status === 'waiting' || first.status === 'lobby' || waitingForDraw(first))) openStream()
      },
      () => {},
    )

    return () => {
      active = false
      source?.close()
      clearInterval(poller)
    }
  }, [eventId, enabled, version])

  const join = useCallback(async (botToken) => {
    setStatus(await joinQueue(eventId, botToken))
    setVersion((v) => v + 1) // start listening for updates
  }, [eventId])

  return { status, join }
}
