// The lucky draw as one person sees it (server: lottery.service.js → status.lottery).
import { useState } from 'react'
import { formatCountdown } from '../lib/serverClock.js'
import { verifyDraw } from '../lib/verifyDraw.js'

const time = (date) => new Date(date).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })

export function LuckyDrawPanel({ draw, eventId, userId }) {
  if (!draw) return null
  const { state, won } = draw

  let body
  if (state === 'upcoming') {
    const oneIn = draw.odds ? Math.max(1, Math.round(1 / draw.odds)) : null
    body = (
      <>
        <p>
          <strong>{draw.tickets.toLocaleString()}</strong> tickets go to a <strong>lucky draw</strong> at{' '}
          {time(draw.drawAt)}: up to {draw.perWinner} each for the winners, drawn at random among everyone in the
          waiting room.
        </p>
        <p>
          {draw.entered ? "You're entered. " : 'Join the waiting room to be entered. '}
          {draw.entrants.toLocaleString()} entered so far
          {oneIn && (oneIn === 1 ? ': there may be enough for everyone.' : `: about 1 in ${oneIn} will win.`)}
        </p>
      </>
    )
  } else if (state === 'drawing' && won && won.passExpiresInSeconds > 0) {
    body = (
      <p>
        🎉 <strong>You won the lucky draw</strong> (round {won.round})! Buy up to {draw.perWinner} lucky-draw ticket
        {draw.perWinner > 1 ? 's' : ''} within <strong>{formatCountdown(won.passExpiresInSeconds)}</strong>.
      </p>
    )
  } else if (state === 'drawing' && won) {
    body = <p>You won in round {won.round}, but the time to buy has passed.</p>
  } else if (state === 'drawing') {
    body = draw.entered ? (
      <p>
        Not this time (round {draw.roundsDone} of {draw.rounds}). If winners don't buy, their tickets are drawn
        again — you're still in. {draw.ticketsLeft.toLocaleString()} lucky-draw tickets left.
      </p>
    ) : (
      <p>The lucky draw has started; only people who joined the waiting room before it are in it.</p>
    )
  } else {
    body = <p>The lucky draw is over. Its remaining tickets went back to the normal sale.</p>
  }

  return (
    <div className="panel">
      <h2>🎟 Lucky draw</h2>
      {body}
      <Fairness draw={draw} eventId={eventId} userId={userId} />
    </div>
  )
}

// "Provably fair": the fingerprint before the draw; after it, the seed and a Verify button that
// checks everything in this browser.
function Fairness({ draw, eventId, userId }) {
  const [result, setResult] = useState(null)
  const short = (hex) => `${hex.slice(0, 16)}…`

  if (!draw.seed) {
    return (
      <p className="muted">
        Fingerprint of the secret draw seed: <code title={draw.seedHash}>{short(draw.seedHash)}</code>. The seed is
        revealed at the draw, so anyone can check it wasn't changed.
      </p>
    )
  }

  async function check() {
    setResult(await verifyDraw({ seed: draw.seed, seedHash: draw.seedHash, eventId, userId, myDrawNumber: draw.myDrawNumber }))
  }

  return (
    <div className="muted">
      <p>
        Seed: <code title={draw.seed}>{short(draw.seed)}</code> · fingerprint published before the draw:{' '}
        <code title={draw.seedHash}>{short(draw.seedHash)}</code>
        {draw.myDrawNumber && (
          <>
            {' '}
            · your draw number: <code title={draw.myDrawNumber}>{short(draw.myDrawNumber)}</code> (lowest numbers win)
          </>
        )}
      </p>
      <button type="button" onClick={check}>
        Verify the draw in my browser
      </button>
      {result && (
        <p>
          {result.fingerprintOk ? '✅' : '❌'} SHA-256(seed) matches the fingerprint published before the draw.{' '}
          {draw.myDrawNumber && (result.numberOk ? '✅ Your draw number is correct.' : '❌ Your draw number does not match.')}
        </p>
      )}
    </div>
  )
}
