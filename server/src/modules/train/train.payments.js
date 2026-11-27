// The train module's adapter for booking payments (modules/booking-payments): where its bookings and
// berths live, the PNR given once a booking is paid, and the receipt.
import { randomInt } from 'node:crypto';
import { registerPaymentTarget } from '../booking-payments/booking-payments.js';
import { formatRupees } from '../../lib/money.js';

// 10 random digits. UNIQUE in the database: on the (1 in 9 billion) clash the payment transaction
// fails, the provider retries its webhook, and the retry draws a new number.
export const newPnr = () => String(randomInt(1_000_000_000, 10_000_000_000));

registerPaymentTarget('train', {
  bookings: 'train_bookings',
  seats: 'train_booking_berths',
  seatColumn: 'berth_label',
  trips: 'train_trips',
  async onPaid(client, bookingId) {
    await client.query('UPDATE train_bookings SET pnr = $2 WHERE id = $1 AND pnr IS NULL', [bookingId, newPnr()]);
  },
  async receipt(client, bookingId) {
    const { rows } = await client.query(
      `SELECT u.email, b.amount_paise, b.pnr, b.class_code, t.train_number, t.train_name, t.origin, t.destination, t.departs_at,
              string_agg(x.berth_label, ', ' ORDER BY x.position) AS berths
         FROM train_bookings AS b JOIN train_trips AS t ON t.id = b.trip_id JOIN users AS u ON u.id = b.user_id
         JOIN train_booking_berths AS x ON x.booking_id = b.id
        WHERE b.id = $1 GROUP BY b.id, t.id, u.email`,
      [bookingId],
    );
    const r = rows[0];
    if (!r) return null;
    return {
      to: r.email,
      subject: `Train booked: PNR ${r.pnr}`,
      text:
        `Your payment of ${formatRupees(r.amount_paise)} is confirmed.\n\n` +
        `PNR ${r.pnr}: ${r.train_number} ${r.train_name}, ${r.origin} → ${r.destination}, departs ${new Date(r.departs_at).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })}\n` +
        `Class ${r.class_code}, berths: ${r.berths}\nBooking: ${bookingId}`,
    };
  },
});
