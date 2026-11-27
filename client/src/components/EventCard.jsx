// One event as a card: status, name, price, how full it is. Used by the events page and the home page.
import { Link } from 'react-router-dom'
import { formatMoney } from '../lib/format.js'
import { formatCountdown, secondsUntil } from '../lib/serverClock.js'
import { eventStatus } from '../lib/eventStatus.js'

export function EventCard({ event, offset = 0 }) {
  const status = eventStatus(event)
  const leftPercent = event.totalTickets ? Math.round((event.available / event.totalTickets) * 100) : 0
  return (
    <li className="event-card">
      <span className={`pill pill--${status.tone}`}>{status.text}</span>
      <h2 className="event-card__name">
        <Link to={`/events/${event.id}`} className="event-card__link">
          {event.name}
        </Link>
      </h2>
      <p className="event-card__price">{formatMoney(event.pricePaise)}</p>
      <div className="availability" aria-hidden="true">
        <span style={{ width: `${leftPercent}%` }} />
      </div>
      <p className="muted event-card__note">
        {event.cancelledAt
          ? 'Cancelled: paid tickets are refunded'
          : event.onSale
            ? `${event.available} of ${event.totalTickets} tickets left`
            : `On sale in ${formatCountdown(secondsUntil(event.saleStartsAt, offset))}`}
      </p>
    </li>
  )
}
