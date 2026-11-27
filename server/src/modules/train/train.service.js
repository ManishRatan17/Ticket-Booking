// Train booking: picks the provider (TRAIN_PROVIDER: local inventory, or a licensed partner),
// shapes what the API shows, and lets admins add the platform's own trains.
import { pool, withTransaction } from '../../config/db.js';
import { env } from '../../config/env.js';
import { AppError } from '../../lib/errors.js';
import * as local from './providers/local.js';
import * as external from './providers/external.js';
import * as repo from './train.repository.js';

// Read on every call, so a test can switch it.
export const provider = () => (env.train.provider === 'external' ? external : local);

// ---------- what the API shows ----------

export function toPublicBooking(b) {
  return {
    id: b.id,
    status: b.status, // held → confirmed | expired; held/confirmed → cancelled
    pnr: b.pnr, // given on confirmation
    classCode: b.classCode,
    trip: b.trip,
    travellers: b.berths.map((x) => ({
      berth: x.berth,
      passenger: x.name ? { name: x.name, age: x.age, gender: x.gender } : null,
    })),
    amountPaise: b.amountPaise,
    heldUntil: b.status === 'held' ? b.heldUntil : null,
    contactPhone: b.contactPhone,
    passengersGiven: Boolean(b.passengersAt),
    // A trip with a fare is confirmed by paying (POST /api/train/bookings/:id/pay/…), which gives the PNR.
    payment: b.amountPaise > 0 ? { required: true, paid: Boolean(b.paidAt), provider: b.paymentProvider, paidAt: b.paidAt } : null,
    refund: b.refund ?? null,
    confirmedAt: b.confirmedAt,
    cancelledAt: b.cancelledAt,
    createdAt: b.createdAt,
  };
}

// ---------- customers: everything goes through the provider ----------

export const searchTrips = (query) => provider().searchTrips(query);
export const listRoutes = () => provider().listRoutes();
export const getTrip = (id) => provider().getTrip(id);
export const holdBerths = (args) => provider().holdBerths(args);
export const confirmBooking = (args) => provider().confirmBooking(args);
export const cancelBooking = (args) => provider().cancelBooking(args);
export const getBooking = (args) => provider().getBooking(args);
export const listBookings = (userId) => provider().listBookings({ userId });

// ---------- admins: the platform's own trains ----------

// Berth labels per class: coach letter(s) + coach number + berth, e.g. 3A coach 2 berth 7 → "B2-7".
const COACH_PREFIX = { '1A': 'H', '2A': 'A', '3A': 'B', SL: 'S', CC: 'C', '2S': 'D' };

export async function createTrip({ classes, ...trip }, adminId) {
  if (env.train.provider !== 'local') {
    throw new AppError(409, 'TRAIN_INVENTORY_EXTERNAL', 'Trains come from the external provider on this server (TRAIN_PROVIDER=external)');
  }
  if (new Date(trip.departsAt) <= new Date()) {
    throw new AppError(400, 'VALIDATION_ERROR', 'The trip must depart in the future', [{ field: 'body.departsAt', message: 'Must be in the future' }]);
  }
  const withBerths = classes.map((c) => {
    const berthLabels = [];
    for (let coach = 1; coach <= c.coaches; coach++) {
      for (let berth = 1; berth <= c.berthsPerCoach; berth++) berthLabels.push(`${COACH_PREFIX[c.code]}${coach}-${berth}`);
    }
    return { code: c.code, farePaise: c.farePaise, berthLabels };
  });
  const id = await withTransaction((client) => repo.insertTrip(client, { ...trip, classes: withBerths, createdBy: adminId }));
  return repo.findTrip(pool, id);
}

export const listTripsForAdmin = () => repo.listUpcomingTrips(pool);
