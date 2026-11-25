// Admin → Manage events: every event with its LIVE numbers (refreshed every 5 s).
import { Link } from 'react-router-dom'
import { formatDate, formatMoney } from '../lib/format.js'
import { EVENT_STATUS_TEXT } from '../lib/eventStatus.js'

export function AdminEventsTable({ events }) {
  if (events.length === 0) return <p className="muted">No events yet.</p>
  return (
    <div className="table-wrap">
      <table className="admin-table">
        <thead>
          <tr>
            <th>Event</th>
            <th>Status</th>
            <th>Sale starts</th>
            <th>Sold</th>
            <th>Held</th>
            <th>Left</th>
            <th>Revenue</th>
            <th>Waiting room</th>
            <th>Lucky draw</th>
          </tr>
        </thead>
        <tbody>
          {events.map((e) => (
            <tr key={e.id}>
              <td>
                <Link to={`/admin/events/${e.id}`}>{e.name}</Link>
                <div className="muted">{formatMoney(e.pricePaise)} each</div>
              </td>
              <td className={`status-${e.status}`}>{EVENT_STATUS_TEXT[e.status]}</td>
              <td>{formatDate(e.saleStartsAt)}</td>
              <td>
                {e.sold} / {e.totalTickets}
              </td>
              <td>{e.held}</td>
              <td>{e.available}</td>
              <td>
                {formatMoney(e.revenuePaise)}
                <div className="muted">{e.paidOrders} orders</div>
              </td>
              <td>{e.admissionPerSecond ? `${e.inLine} in line · ${e.admissionPerSecond}/s` : '—'}</td>
              <td>
                {e.luckyDraw
                  ? `${e.luckyDraw.left}/${e.luckyDraw.tickets} left · ${e.luckyDraw.entered} entered${e.luckyDraw.open ? '' : ' · over'}`
                  : '—'}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
