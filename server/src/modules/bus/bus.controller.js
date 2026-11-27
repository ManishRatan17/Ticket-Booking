// HTTP ⇄ bus service: read the validated request, call the service, shape the answer.
import * as bus from './bus.service.js';

export async function searchTrips(req, res) {
  const trips = await bus.searchTrips(req.validated.query);
  res.json({ trips: trips.map(bus.toPublicTrip) });
}

export async function getTrip(req, res) {
  res.json({ trip: await bus.getTripWithSeats(req.validated.params.id) });
}

export async function holdSeats(req, res) {
  const { booking, created } = await bus.holdSeats({
    tripId: req.validated.params.id,
    userId: req.user.id,
    seats: req.validated.body.seats,
    idempotencyKey: req.idempotencyKey,
  });
  // 201 the first time; 200 + a header saying "this is the earlier answer" on a retry.
  if (!created) res.set('Idempotent-Replayed', 'true');
  res.status(created ? 201 : 200).json({ booking: bus.toPublicBooking(booking) });
}

export async function confirmBooking(req, res) {
  const booking = await bus.confirmBooking({ bookingId: req.validated.params.id, userId: req.user.id, ...req.validated.body });
  res.json({ booking: bus.toPublicBooking(booking) });
}

export async function cancelBooking(req, res) {
  const booking = await bus.cancelBooking({ bookingId: req.validated.params.id, userId: req.user.id });
  res.json({ booking: bus.toPublicBooking(booking) });
}

export async function listBookings(req, res) {
  res.json({ bookings: (await bus.listBookings(req.user.id)).map(bus.toPublicBooking) });
}

export async function getBooking(req, res) {
  res.json({ booking: bus.toPublicBooking(await bus.getBooking({ bookingId: req.validated.params.id, userId: req.user.id })) });
}

// ---------- admins ----------

export async function createTrip(req, res) {
  const trip = await bus.createTrip(req.validated.body, req.user.id);
  res.locals.auditTargetId = trip.id; // the audit log records the new trip's id
  res.status(201).json({ trip: { ...bus.toPublicTrip(trip), seatLabels: trip.seatLabels } });
}

export async function listTripsForAdmin(req, res) {
  res.json({ trips: (await bus.listTripsForAdmin()).map(bus.toPublicTrip) });
}
