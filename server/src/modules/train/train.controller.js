// HTTP ⇄ train service: read the validated request, call the service, shape the answer.
import * as train from './train.service.js';

export async function searchTrips(req, res) {
  res.json({ trips: await train.searchTrips(req.validated.query) });
}

export async function listRoutes(req, res) {
  res.json({ routes: await train.listRoutes() });
}

export async function getTrip(req, res) {
  res.json({ trip: await train.getTrip(req.validated.params.id) });
}

export async function holdBerths(req, res) {
  const { booking, created } = await train.holdBerths({
    tripId: req.validated.params.id,
    userId: req.user.id,
    ...req.validated.body,
    idempotencyKey: req.idempotencyKey,
  });
  // 201 the first time; 200 + a header saying "this is the earlier answer" on a retry.
  if (!created) res.set('Idempotent-Replayed', 'true');
  res.status(created ? 201 : 200).json({ booking: train.toPublicBooking(booking), serverTime: new Date() });
}

export async function confirmBooking(req, res) {
  const booking = await train.confirmBooking({ bookingId: req.validated.params.id, userId: req.user.id, ...req.validated.body });
  res.json({ booking: train.toPublicBooking(booking) });
}

export async function cancelBooking(req, res) {
  const booking = await train.cancelBooking({ bookingId: req.validated.params.id, userId: req.user.id });
  res.json({ booking: train.toPublicBooking(booking) });
}

export async function listBookings(req, res) {
  res.json({ bookings: (await train.listBookings(req.user.id)).map(train.toPublicBooking) });
}

export async function getBooking(req, res) {
  // serverTime: the page counts the hold down on the server's clock, not the visitor's.
  res.json({ booking: train.toPublicBooking(await train.getBooking({ bookingId: req.validated.params.id, userId: req.user.id })), serverTime: new Date() });
}

// ---------- admins ----------

export async function createTrip(req, res) {
  const trip = await train.createTrip(req.validated.body, req.user.id);
  res.locals.auditTargetId = trip.id; // the audit log records the new trip's id
  res.status(201).json({ trip });
}

export async function listTripsForAdmin(req, res) {
  res.json({ trips: await train.listTripsForAdmin() });
}
