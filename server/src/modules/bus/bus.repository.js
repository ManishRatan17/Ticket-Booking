// SQL for the bus module (tables: migration 016). Functions take a `client`: the pool, or a
// transaction's connection.

// A seat is TAKEN when it belongs to a confirmed booking, or to a hold that hasn't run out.
// (A hold past its time is free even before it's marked expired: the next hold expires it.)
const TAKEN = `s.active AND (b.status = 'confirmed' OR (b.status = 'held' AND b.held_until > now()))`;

function toTrip(r) {
  return {
    id: Number(r.id),
    operator: r.operator,
    busNumber: r.bus_number,
    from: r.origin,
    to: r.destination,
    departsAt: r.departs_at,
    arrivesAt: r.arrives_at,
    farePaise: r.fare_paise,
    seatLabels: r.seat_labels,
    totalSeats: r.seat_labels.length,
    cancelledAt: r.cancelled_at,
    ...(r.seats_left !== undefined && { seatsLeft: Number(r.seats_left) }),
  };
}

export async function insertTrip(client, t) {
  const { rows } = await client.query(
    `INSERT INTO bus_trips (operator, bus_number, origin, destination, departs_at, arrives_at, fare_paise, seat_labels, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *`,
    [t.operator, t.busNumber, t.from, t.to, t.departsAt, t.arrivesAt, t.farePaise, t.seatLabels, t.createdBy],
  );
  return toTrip(rows[0]);
}

const SEATS_LEFT = `cardinality(t.seat_labels) - (
    SELECT count(*) FROM bus_booking_seats AS s JOIN bus_bookings AS b ON b.id = s.booking_id
     WHERE s.trip_id = t.id AND ${TAKEN}) AS seats_left`;

// Trips from → to (any letter case) departing on `date`, as a calendar day in `timeZone`; only
// trips that haven't left and aren't cancelled.
export async function searchTrips(client, { from, to, date, timeZone }) {
  const { rows } = await client.query(
    `SELECT t.*, ${SEATS_LEFT}
       FROM bus_trips AS t
      WHERE lower(t.origin) = lower($1) AND lower(t.destination) = lower($2)
        AND t.departs_at >= ($3::date)::timestamp AT TIME ZONE $4
        AND t.departs_at <  ($3::date + 1)::timestamp AT TIME ZONE $4
        AND t.departs_at > now() AND t.cancelled_at IS NULL
      ORDER BY t.departs_at, t.id`,
    [from, to, date, timeZone],
  );
  return rows.map(toTrip);
}

export async function listUpcomingTrips(client) {
  const { rows } = await client.query(
    `SELECT t.*, ${SEATS_LEFT} FROM bus_trips AS t WHERE t.departs_at > now() - interval '1 day' ORDER BY t.departs_at, t.id LIMIT 200`,
  );
  return rows.map(toTrip);
}

// { lock: true } = SELECT … FOR UPDATE: every booking change on a trip takes this lock FIRST, so
// changes to one trip's seats happen one after another (lock order: trip, then booking).
export async function findTrip(client, id, { lock = false } = {}) {
  const { rows } = await client.query(`SELECT * FROM bus_trips WHERE id = $1${lock ? ' FOR UPDATE' : ''}`, [id]);
  return rows[0] ? toTrip(rows[0]) : null;
}

export async function takenSeats(client, tripId) {
  const { rows } = await client.query(
    `SELECT s.seat_label FROM bus_booking_seats AS s JOIN bus_bookings AS b ON b.id = s.booking_id
      WHERE s.trip_id = $1 AND ${TAKEN}`,
    [tripId],
  );
  return new Set(rows.map((r) => r.seat_label));
}

// Holds past their time become 'expired' and give their seats back. Returns how many.
export async function expireOverdueHolds(client, tripId) {
  const { rows } = await client.query(
    `UPDATE bus_bookings SET status = 'expired', updated_at = now()
      WHERE trip_id = $1 AND status = 'held' AND held_until <= now() RETURNING id`,
    [tripId],
  );
  if (rows.length) {
    await client.query('UPDATE bus_booking_seats SET active = false WHERE booking_id = ANY($1::bigint[])', [rows.map((r) => r.id)]);
  }
  return rows.length;
}

export async function insertBooking(client, { tripId, userId, seats, amountPaise, idempotencyKey, holdMinutes }) {
  const { rows } = await client.query(
    `INSERT INTO bus_bookings (trip_id, user_id, amount_paise, idempotency_key, held_until)
     VALUES ($1, $2, $3, $4, now() + make_interval(mins => $5)) RETURNING id`,
    [tripId, userId, amountPaise, idempotencyKey, holdMinutes],
  );
  const id = Number(rows[0].id);
  await client.query(
    `INSERT INTO bus_booking_seats (booking_id, trip_id, seat_label) SELECT $1, $2, unnest($3::text[])`,
    [id, tripId, seats],
  );
  return id;
}

const BOOKING_SELECT = `
  SELECT b.*, t.operator, t.bus_number, t.origin, t.destination, t.departs_at, t.arrives_at,
         (t.cancelled_at IS NOT NULL) AS trip_cancelled,
         (SELECT json_build_object('status', rf.status, 'amountPaise', rf.amount_paise, 'reason', rf.reason, 'refundedAt', rf.refunded_at)
            FROM refunds AS rf WHERE rf.booking_kind = 'bus' AND rf.booking_id = b.id ORDER BY rf.id DESC LIMIT 1) AS refund,
         json_agg(json_build_object('label', s.seat_label, 'name', s.passenger_name, 'age', s.passenger_age,
                                    'gender', s.passenger_gender) ORDER BY s.seat_label) AS seats
    FROM bus_bookings AS b
    JOIN bus_trips AS t ON t.id = b.trip_id
    JOIN bus_booking_seats AS s ON s.booking_id = b.id`;

function toBooking(r) {
  return {
    id: Number(r.id),
    userId: Number(r.user_id),
    tripId: Number(r.trip_id),
    status: r.status,
    amountPaise: r.amount_paise,
    idempotencyKey: r.idempotency_key,
    heldUntil: r.held_until,
    contactPhone: r.contact_phone,
    passengersAt: r.passengers_at,
    paymentProvider: r.payment_provider,
    paymentId: r.payment_id,
    paidAt: r.paid_at,
    refund: r.refund ?? null,
    confirmedAt: r.confirmed_at,
    cancelledAt: r.cancelled_at,
    createdAt: r.created_at,
    trip: {
      id: Number(r.trip_id),
      operator: r.operator,
      busNumber: r.bus_number,
      from: r.origin,
      to: r.destination,
      departsAt: r.departs_at,
      arrivesAt: r.arrives_at,
      cancelled: r.trip_cancelled,
    },
    seats: r.seats,
  };
}

// Ownership is part of the query: someone else's booking simply isn't found (→ 404).
export async function findBooking(client, id, userId, { lock = false } = {}) {
  if (lock) await client.query('SELECT id FROM bus_bookings WHERE id = $1 AND user_id = $2 FOR UPDATE', [id, userId]);
  const { rows } = await client.query(`${BOOKING_SELECT} WHERE b.id = $1 AND b.user_id = $2 GROUP BY b.id, t.id`, [id, userId]);
  return rows[0] ? toBooking(rows[0]) : null;
}

export async function findBookingByKey(client, userId, key) {
  const { rows } = await client.query(`${BOOKING_SELECT} WHERE b.user_id = $1 AND b.idempotency_key = $2 GROUP BY b.id, t.id`, [userId, key]);
  return rows[0] ? toBooking(rows[0]) : null;
}

export async function listBookings(client, userId) {
  const { rows } = await client.query(`${BOOKING_SELECT} WHERE b.user_id = $1 GROUP BY b.id, t.id ORDER BY b.created_at DESC LIMIT 100`, [userId]);
  return rows.map(toBooking);
}

// Saves the passengers; confirms too when `confirm` (a free trip). A paid trip is confirmed by its
// payment (modules/booking-payments).
export async function confirmBooking(client, { id, passengers, contactPhone, confirm = true }) {
  await client.query(
    `UPDATE bus_booking_seats AS s SET passenger_name = p.name, passenger_age = p.age, passenger_gender = p.gender
       FROM json_to_recordset($2::json) AS p(seat text, name text, age int, gender text)
      WHERE s.booking_id = $1 AND s.seat_label = p.seat`,
    [id, JSON.stringify(passengers)],
  );
  await client.query(
    confirm
      ? `UPDATE bus_bookings SET status = 'confirmed', contact_phone = $2, passengers_at = now(), confirmed_at = now(), updated_at = now() WHERE id = $1`
      : `UPDATE bus_bookings SET contact_phone = $2, passengers_at = now(), updated_at = now() WHERE id = $1`,
    [id, contactPhone ?? null],
  );
}

export async function cancelBooking(client, id) {
  await client.query(`UPDATE bus_bookings SET status = 'cancelled', cancelled_at = now(), updated_at = now() WHERE id = $1`, [id]);
  await client.query('UPDATE bus_booking_seats SET active = false WHERE booking_id = $1', [id]);
}

// Upcoming routes (from → to, with how many trips and the next departure): the search form's suggestions.
export async function listRoutes(client) {
  const { rows } = await client.query(
    `SELECT origin, destination, count(*)::int AS trips, min(departs_at) AS next_departure
       FROM bus_trips WHERE departs_at > now() AND cancelled_at IS NULL
      GROUP BY origin, destination ORDER BY min(departs_at) LIMIT 100`,
  );
  return rows.map((r) => ({ from: r.origin, to: r.destination, trips: r.trips, nextDeparture: r.next_departure }));
}
