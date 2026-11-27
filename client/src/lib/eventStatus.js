// Words for an event's live status (admin pages).
export const EVENT_STATUS_TEXT = {
  upcoming: 'Upcoming',
  on_sale: 'On sale',
  all_held: 'All held (unpaid holds may come back)',
  sold_out: 'Sold out',
  cancelled: 'Cancelled',
}

// The status pill of an event for customers (event cards, the event page).
export function eventStatus(event) {
  if (event.cancelledAt) return { text: 'Cancelled', tone: 'danger' }
  if (!event.onSale) return { text: 'Coming soon', tone: 'info' }
  return event.available > 0 ? { text: 'On sale', tone: 'success' } : { text: 'All taken', tone: 'warning' }
}
