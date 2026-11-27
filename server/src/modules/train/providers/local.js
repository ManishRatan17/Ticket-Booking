// The LOCAL train provider: the platform's own trains (added by admins), booked in our database.
//
//   search ──► a trip's classes with berths available ──► HOLD (class + travellers, 10 min,
//   Idempotency-Key): the server allocates the first free berths of that class ──► CONFIRM with the
//   travellers' details → a PNR ──► history; CANCEL (berths go back) before departure.
//
// Concurrency: every change to a trip's bookings locks the TRIP row first, so allocations on one
// trip take turns; and the database refuses a berth in two active bookings (unique index, migration 017).
import { pool, withTransaction } from '../../../config/db.js';
import { AppError } from '../../../lib/errors.js';
import { isUniqueViolation } from '../../../lib/db-errors.js';
import * as repo from '../train.repository.js';
import { newPnr } from '../train.payments.js';
import { refundOnCancel, requestRefund } from '../../booking-payments/booking-payments.js';

export const name = 'local';
export const HOLD_MINUTES = 10;
const TIME_ZONE = 'Asia/Kolkata'; // "travel date" = a calendar day in India

export const searchTrips = ({ from, to, date, classCode }) => repo.searchTrips(pool, { from, to, date, timeZone: TIME_ZONE, classCode });

export const listRoutes = () => repo.listRoutes(pool);

export async function getTrip(id) {
  const trip = await repo.findTrip(pool, id);
  if (!trip) throw new AppError(404, 'TRAIN_TRIP_NOT_FOUND', 'No train trip with this id');
  return trip;
}

function checkBookable(trip) {
  if (!trip) throw new AppError(404, 'TRAIN_TRIP_NOT_FOUND', 'No train trip with this id');
  if (trip.cancelledAt) throw new AppError(409, 'TRAIN_TRIP_CANCELLED', 'This train has been cancelled');
  if (new Date(trip.departsAt) <= new Date()) throw new AppError(409, 'TRAIN_TRIP_DEPARTED', 'This train has already left');
}

const sameRequest = (booking, tripId, classCode, travellers) =>
  booking.tripId === tripId && booking.classCode === classCode && booking.berths.length === travellers;

// Returns { booking, created }. created = false: a retry with the same Idempotency-Key.
export async function holdBerths({ tripId, userId, classCode, travellers, idempotencyKey }) {
  try {
    return await withTransaction(async (client) => {
      const trip = await repo.findTrip(client, tripId, { lock: true }); // 1. the trip, locked

      const earlier = await repo.findBookingByKey(client, userId, idempotencyKey); // 2. a retry?
      if (earlier) {
        if (!sameRequest(earlier, tripId, classCode, travellers)) {
          throw new AppError(422, 'IDEMPOTENCY_KEY_REUSED', 'This idempotency key was already used for a different request');
        }
        return { booking: earlier, created: false };
      }

      checkBookable(trip);
      const cls = await repo.findClass(client, tripId, classCode);
      if (!cls) throw new AppError(400, 'CLASS_NOT_OFFERED', `This train has no ${classCode} class`, { classes: trip.classes.map((c) => c.code) });

      await repo.expireOverdueHolds(client, tripId); // 3. holds that ran out give their berths back
      const taken = await repo.takenBerths(client, tripId);
      const free = cls.berthLabels.filter((b) => !taken.has(b));
      if (free.length < travellers) {
        throw new AppError(409, 'NOT_ENOUGH_BERTHS', `Only ${free.length} ${classCode} berths left`, { available: free.length });
      }

      const id = await repo.insertBooking(client, {
        tripId,
        userId,
        classCode,
        berths: free.slice(0, travellers), // 4. the first free berths, in the class's order
        amountPaise: cls.farePaise * travellers, // the price comes from the database, never the request
        idempotencyKey,
        holdMinutes: HOLD_MINUTES,
      });
      return { booking: await repo.findBooking(client, id, userId), created: true };
    });
  } catch (err) {
    // The database's own guarantees, should two requests ever get this far together:
    if (isUniqueViolation(err, 'train_bookings_user_id_idempotency_key_key')) {
      const earlier = await repo.findBookingByKey(pool, userId, idempotencyKey);
      if (earlier && sameRequest(earlier, tripId, classCode, travellers)) return { booking: earlier, created: false };
      throw new AppError(422, 'IDEMPOTENCY_KEY_REUSED', 'This idempotency key was already used for a different request');
    }
    if (isUniqueViolation(err, 'train_berth_taken_once_idx')) throw new AppError(409, 'NOT_ENOUGH_BERTHS', 'Those berths were just taken; please try again');
    if (isUniqueViolation(err, 'train_bookings_one_hold_idx')) {
      throw new AppError(409, 'TRAIN_HOLD_EXISTS', 'You already have berths on hold on this train: confirm or cancel them first');
    }
    throw err;
  }
}

// Locks the trip, then the booking (always that order), and returns them, or 404.
async function lockOwnBooking(client, bookingId, userId) {
  const found = await repo.findBooking(client, bookingId, userId);
  if (!found) throw new AppError(404, 'TRAIN_BOOKING_NOT_FOUND', 'No booking with this id');
  const trip = await repo.findTrip(client, found.tripId, { lock: true });
  const booking = await repo.findBooking(client, bookingId, userId, { lock: true }); // re-read under the locks
  return { trip, booking };
}

export async function confirmBooking({ bookingId, userId, passengers, contactPhone }) {
  // A PNR is random; if one ever repeats (1 in 9 billion), the unique index refuses it: try again.
  for (let attempt = 1; ; attempt++) {
    try {
      return await withTransaction(async (client) => {
        const { trip, booking } = await lockOwnBooking(client, bookingId, userId);
        if (booking.status === 'confirmed') return booking; // confirmed already (a retry): same answer
        if (booking.status !== 'held') {
          throw new AppError(409, 'TRAIN_BOOKING_NOT_HELD', `This booking is ${booking.status}`, { status: booking.status });
        }
        if (new Date(booking.heldUntil) <= new Date()) {
          throw new AppError(409, 'TRAIN_HOLD_EXPIRED', 'Your berths were held for 10 minutes and that time is up; please book again');
        }
        checkBookable(trip);
        if (passengers.length !== booking.berths.length) {
          throw new AppError(400, 'PASSENGERS_MISMATCH', `Give exactly ${booking.berths.length} travellers (one per held berth)`, {
            travellers: booking.berths.length,
          });
        }
        // A free trip is confirmed now (with its PNR); otherwise the travellers are saved and the
        // booking waits for payment, which gives the PNR (train.payments.js).
        await repo.confirmBooking(client, { id: bookingId, passengers, contactPhone, pnr: booking.amountPaise === 0 ? newPnr() : null });
        return repo.findBooking(client, bookingId, userId);
      });
    } catch (err) {
      if (attempt < 3 && isUniqueViolation(err, 'train_bookings_pnr_key')) continue;
      throw err;
    }
  }
}

export async function cancelBooking({ bookingId, userId }) {
  const { booking, refundId } = await withTransaction(async (client) => {
    const { trip, booking } = await lockOwnBooking(client, bookingId, userId);
    if (booking.status !== 'held' && booking.status !== 'confirmed') {
      throw new AppError(409, 'TRAIN_BOOKING_NOT_ACTIVE', `This booking is already ${booking.status}`, { status: booking.status });
    }
    if (new Date(trip.departsAt) <= new Date()) throw new AppError(409, 'TRAIN_TRIP_DEPARTED', 'This train has already left');
    const refundId = await refundOnCancel(client, 'train', booking); // paid → the money goes back (recorded here)
    await repo.cancelBooking(client, bookingId);
    return { booking: await repo.findBooking(client, bookingId, userId), refundId };
  });
  if (refundId) await requestRefund(refundId);
  return refundId ? repo.findBooking(pool, bookingId, userId) : booking;
}

export async function getBooking({ bookingId, userId }) {
  const booking = await repo.findBooking(pool, bookingId, userId);
  if (!booking) throw new AppError(404, 'TRAIN_BOOKING_NOT_FOUND', 'No booking with this id');
  return booking;
}

export const listBookings = ({ userId }) => repo.listBookings(pool, userId);
