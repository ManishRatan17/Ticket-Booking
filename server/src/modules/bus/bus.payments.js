// The bus module's adapter for booking payments (modules/booking-payments): where its bookings and
// seats live, and the receipt sent once a booking is paid.
import { registerPaymentTarget } from '../booking-payments/booking-payments.js';
import { formatRupees } from '../../lib/money.js';

registerPaymentTarget('bus', {
  bookings: 'bus_bookings',
  seats: 'bus_booking_seats',
  seatColumn: 'seat_label',
  trips: 'bus_trips',
  async receipt(client, bookingId) {
    const { rows } = await client.query(
      `SELECT u.email, b.amount_paise, t.operator, t.bus_number, t.origin, t.destination, t.departs_at,
              string_agg(s.seat_label, ', ' ORDER BY s.seat_label) AS seats
         FROM bus_bookings AS b JOIN bus_trips AS t ON t.id = b.trip_id JOIN users AS u ON u.id = b.user_id
         JOIN bus_booking_seats AS s ON s.booking_id = b.id
        WHERE b.id = $1 GROUP BY b.id, t.id, u.email`,
      [bookingId],
    );
    const r = rows[0];
    if (!r) return null;
    return {
      to: r.email,
      subject: `Bus booked: ${r.origin} → ${r.destination}`,
      text:
        `Your payment of ${formatRupees(r.amount_paise)} is confirmed.\n\n` +
        `${r.operator}, bus ${r.bus_number}: ${r.origin} → ${r.destination}, departs ${new Date(r.departs_at).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })}\n` +
        `Seats: ${r.seats}\nBooking: ${bookingId}`,
    };
  },
});
