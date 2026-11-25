// "What are my chances?" for someone waiting (the server estimates it: server/.../waiting-room/chance.js).
// Shown as a level, because the real number is a rough guess.
const LEVELS = {
  good: { label: 'Good chance', className: 'chance chance-good' },
  maybe: { label: 'Maybe', className: 'chance chance-maybe' },
  unlikely: { label: 'Unlikely', className: 'chance chance-unlikely' },
}

export function ChanceNote({ status }) {
  const level = LEVELS[status.chance]
  if (!level) return null
  const tickets = status.ticketsLeft.toLocaleString()
  const buyers = status.buyersLeft.toLocaleString()

  let detail
  if (status.status === 'lobby') {
    detail =
      status.buyersLeft >= status.total
        ? `${tickets} tickets left: enough for everyone in the lobby if people buy about 2 each.`
        : `${tickets} tickets left, enough for roughly ${buyers} buyers. About 1 in ${Math.max(1, Math.round(status.total / Math.max(1, status.buyersLeft)))} people here will get tickets.`
  } else if (status.chance === 'good') {
    detail = `${tickets} tickets left, enough for roughly ${buyers} buyers, and ${(status.position - 1).toLocaleString()} people are ahead of you.`
  } else if (status.chance === 'maybe') {
    detail = `${tickets} tickets left (roughly ${buyers} buyers): they may run out around your place in line.`
  } else {
    detail = `${tickets} tickets left (roughly ${buyers} buyers): they will probably sell out before your turn.`
  }

  return (
    <p>
      <span className={level.className}>{level.label}</span> {detail}{' '}
      <span className="muted">(An estimate: it changes as tickets sell.)</span>
    </p>
  )
}
