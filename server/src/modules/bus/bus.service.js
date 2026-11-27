// Bus booking rules. No HTTP in here.
//
//   search trips (from, to, date) ──► a trip's seat map ──► HOLD seats (10 min, Idempotency-Key)
//     ──► CONFIRM with passenger details ──► booking history; CANCEL (seats go back) any time
//         before departure. Payment is added in a later step: confirming needs no payment yet.
//
// Concurrency: every change to a trip's bookings locks the TRIP row first (SELECT … FOR UPDATE),
// so holds on one trip take turns. On top, the database refuses a seat in two active bookings
// (unique index, migration 016), so even a bug here couldn't double-book a seat.
import { pool, withTransaction } from '../../config/db.js';
import { AppError } from '../../lib/errors.js';
import { isUniqueViolation } from '../../lib/db-errors.js';
import * as repo from './bus.repository.js';
import { refundOnCancel, requestRefund } from '../booking-payments/booking-payments.js';

export const HOLD_MINUTES = 10;
const TIME_ZONE = 'Asia/Kolkata'; // "travel date" = a calendar day in India

// ---------- what the API shows ----------

export function toPublicTrip(trip) {
  const { seatLabels: _, ...rest } = trip;
  return rest;
}

export function toPublicBooking(b) {
  return {
    id: b.id,
    status: b.status, // held → confirmed | expired; held/confirmed → cancelled
    trip: b.trip,
    seats: b.seats.map((s) => ({
      label: s.label,
      passenger: s.name ? { name: s.name, age: s.age, gender: s.gender } : null,
    })),
    amountPaise: b.amountPaise,
    heldUntil: b.status === 'held' ? b.heldUntil : null,
    contactPhone: b.contactPhone,
    passengersGiven: Boolean(b.passengersAt),
    // A trip with a fare is confirmed by paying (POST /api/bus/bookings/:id/pay/…); free trips need no payment.
    payment: b.amountPaise > 0 ? { required: true, paid: Boolean(b.paidAt), provider: b.paymentProvider, paidAt: b.paidAt } : null,
    refund: b.refund,
    confirmedAt: b.confirmedAt,
    cancelledAt: b.cancelledAt,
    createdAt: b.createdAt,
  };
}

// ---------- trips ----------

export async function searchTrips({ from, to, date }) {
  return repo.searchTrips(pool, { from, to, date, timeZone: TIME_ZONE });
}

export async function getTripWithSeats(id) {
  const trip = await repo.findTrip(pool, id);
  if (!trip) throw new AppError(404, 'BUS_TRIP_NOT_FOUND', 'No bus trip with this id');
  const taken = await repo.takenSeats(pool, id);
  return {
    ...toPublicTrip(trip),
    seatsLeft: trip.totalSeats - taken.size,
    // Who sits where is never shown: only taken or free.
    seats: trip.seatLabels.map((label) => ({ label, taken: taken.has(label) })),
  };
}

export async function createTrip({ rows, seatColumns, ...trip }, adminId) {
  const seatLabels = [];
  for (let r = 1; r <= rows; r++) for (const c of seatColumns) seatLabels.push(`${r}${c}`);
  if (new Date(trip.departsAt) <= new Date()) {
    throw new AppError(400, 'VALIDATION_ERROR', 'The trip must depart in the future', [{ field: 'body.departsAt', message: 'Must be in the future' }]);
  }
  return repo.insertTrip(pool, { ...trip, seatLabels, createdBy: adminId });
}

export const listTripsForAdmin = () => repo.listUpcomingTrips(pool);

// ---------- holding seats ----------

function checkBookable(trip) {
  if (!trip) throw new AppError(404, 'BUS_TRIP_NOT_FOUND', 'No bus trip with this id');
  if (trip.cancelledAt) throw new AppError(409, 'BUS_TRIP_CANCELLED', 'This trip has been cancelled');
  if (new Date(trip.departsAt) <= new Date()) throw new AppError(409, 'BUS_TRIP_DEPARTED', 'This bus has already left');
}

const sameSeats = (a, b) => a.length === b.length && [...a].sort().join() === [...b].sort().join();

// Returns { booking, created }. created = false: a retry with the same Idempotency-Key.
export async function holdSeats({ tripId, userId, seats, idempotencyKey }) {
  try {
    return await withTransaction(async (client) => {
      const trip = await repo.findTrip(client, tripId, { lock: true }); // 1. the trip, locked

      // 2. A retry of a request we already handled? Answer with the same booking. (Checked AFTER the
      //    lock, so two parallel requests with one key can't both get past it.)
      const earlier = await repo.findBookingByKey(client, userId, idempotencyKey);
      if (earlier) {
        if (earlier.tripId !== tripId || !sameSeats(earlier.seats.map((s) => s.label), seats)) {
          throw new AppError(422, 'IDEMPOTENCY_KEY_REUSED', 'This idempotency key was already used for a different request');
        }
        return { booking: earlier, created: false };
      }

      checkBookable(trip);
      const unknown = seats.filter((s) => !trip.seatLabels.includes(s));
      if (unknown.length) throw new AppError(400, 'UNKNOWN_SEATS', `This bus has no seat ${unknown.join(', ')}`, { seats: unknown });

      await repo.expireOverdueHolds(client, tripId); // 3. holds that ran out give their seats back
      const taken = await repo.takenSeats(client, tripId);
      const clash = seats.filter((s) => taken.has(s));
      if (clash.length) throw new AppError(409, 'SEATS_TAKEN', `Already taken: ${clash.join(', ')}`, { seats: clash });

      const id = await repo.insertBooking(client, {
        tripId,
        userId,
        seats,
        amountPaise: trip.farePaise * seats.length, // the price comes from the database, never the request
        idempotencyKey,
        holdMinutes: HOLD_MINUTES,
      });
      return { booking: await repo.findBooking(client, id, userId), created: true };
    });
  } catch (err) {
    // The database's own guarantees, should two requests ever get this far together:
    if (isUniqueViolation(err, 'bus_bookings_user_id_idempotency_key_key')) {
      // The same request, inserted by a parallel retry a moment ago: answer with that booking.
      const earlier = await repo.findBookingByKey(pool, userId, idempotencyKey);
      if (earlier && earlier.tripId === tripId && sameSeats(earlier.seats.map((s) => s.label), seats)) return { booking: earlier, created: false };
      throw new AppError(422, 'IDEMPOTENCY_KEY_REUSED', 'This idempotency key was already used for a different request');
    }
    if (isUniqueViolation(err, 'bus_seat_taken_once_idx')) throw new AppError(409, 'SEATS_TAKEN', 'One of these seats was just taken', { seats });
    if (isUniqueViolation(err, 'bus_bookings_one_hold_idx')) {
      throw new AppError(409, 'BUS_HOLD_EXISTS', 'You already have seats on hold on this bus: confirm or cancel them first');
    }
    throw err;
  }
}

// ---------- confirming, cancelling, history ----------

// Locks the trip, then the booking (always that order), and returns the booking, or 404.
async function lockOwnBooking(client, bookingId, userId) {
  const found = await repo.findBooking(client, bookingId, userId);
  if (!found) throw new AppError(404, 'BUS_BOOKING_NOT_FOUND', 'No booking with this id');
  const trip = await repo.findTrip(client, found.tripId, { lock: true });
  const booking = await repo.findBooking(client, bookingId, userId, { lock: true }); // re-read under the locks
  return { trip, booking };
}

export async function confirmBooking({ bookingId, userId, passengers, contactPhone }) {
  return withTransaction(async (client) => {
    const { trip, booking } = await lockOwnBooking(client, bookingId, userId);
    if (booking.status === 'confirmed') return booking; // confirmed already (a retry): same answer
    if (booking.status !== 'held') {
      throw new AppError(409, 'BUS_BOOKING_NOT_HELD', `This booking is ${booking.status}`, { status: booking.status });
    }
    if (new Date(booking.heldUntil) <= new Date()) {
      throw new AppError(409, 'BUS_HOLD_EXPIRED', 'Your seats were held for 10 minutes and that time is up; please choose seats again');
    }
    checkBookable(trip);

    const held = booking.seats.map((s) => s.label);
    if (!sameSeats(held, passengers.map((p) => p.seat))) {
      throw new AppError(400, 'PASSENGERS_MISMATCH', `Give one passenger for each held seat: ${held.join(', ')}`, { seats: held });
    }
    // A free trip is confirmed now; otherwise the passengers are saved and the booking waits for payment.
    await repo.confirmBooking(client, { id: bookingId, passengers, contactPhone, confirm: booking.amountPaise === 0 });
    return repo.findBooking(client, bookingId, userId);
  });
}

export async function cancelBooking({ bookingId, userId }) {
  const { booking, refundId } = await withTransaction(async (client) => {
    const { trip, booking } = await lockOwnBooking(client, bookingId, userId);
    if (booking.status !== 'held' && booking.status !== 'confirmed') {
      throw new AppError(409, 'BUS_BOOKING_NOT_ACTIVE', `This booking is already ${booking.status}`, { status: booking.status });
    }
    if (new Date(trip.departsAt) <= new Date()) throw new AppError(409, 'BUS_TRIP_DEPARTED', 'This bus has already left');
    const refundId = await refundOnCancel(client, 'bus', booking); // paid → the money goes back (recorded here)
    await repo.cancelBooking(client, bookingId);
    return { booking: await repo.findBooking(client, bookingId, userId), refundId };
  });
  if (refundId) await requestRefund(refundId);
  return refundId ? repo.findBooking(pool, bookingId, userId) : booking;
}

export async function getBooking({ bookingId, userId }) {
  const booking = await repo.findBooking(pool, bookingId, userId);
  if (!booking) throw new AppError(404, 'BUS_BOOKING_NOT_FOUND', 'No booking with this id');
  return booking;
}

export const listBookings = (userId) => repo.listBookings(pool, userId);
