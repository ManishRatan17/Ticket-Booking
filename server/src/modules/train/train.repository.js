// SQL for the train module (tables: migration 017). Functions take a `client`: the pool, or a
// transaction's connection.

// A berth is TAKEN when it belongs to a confirmed booking, or to a hold that hasn't run out.
const TAKEN = `x.active AND (b.status = 'confirmed' OR (b.status = 'held' AND b.held_until > now()))`;
// Classes listed best first.
const CLASS_ORDER = `array_position(ARRAY['1A','2A','3A','SL','CC','2S'], c.class_code)`;

const CLASSES_JSON = `(
  SELECT json_agg(json_build_object(
           'code', c.class_code, 'farePaise', c.fare_paise, 'total', cardinality(c.berth_labels),
           'available', cardinality(c.berth_labels) - (
              SELECT count(*) FROM train_booking_berths AS x JOIN train_bookings AS b ON b.id = x.booking_id
               WHERE x.trip_id = c.trip_id AND b.class_code = c.class_code AND ${TAKEN})
         ) ORDER BY ${CLASS_ORDER})
    FROM train_trip_classes AS c WHERE c.trip_id = t.id) AS classes`;

function toTrip(r) {
  return {
    id: Number(r.id),
    trainNumber: r.train_number,
    trainName: r.train_name,
    from: r.origin,
    to: r.destination,
    departsAt: r.departs_at,
    arrivesAt: r.arrives_at,
    cancelledAt: r.cancelled_at,
    classes: r.classes ?? [],
  };
}

export async function insertTrip(client, t) {
  const { rows } = await client.query(
    `INSERT INTO train_trips (train_number, train_name, origin, destination, departs_at, arrives_at, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
    [t.trainNumber, t.trainName, t.from, t.to, t.departsAt, t.arrivesAt, t.createdBy],
  );
  const id = Number(rows[0].id);
  for (const c of t.classes) {
    await client.query('INSERT INTO train_trip_classes (trip_id, class_code, fare_paise, berth_labels) VALUES ($1, $2, $3, $4)', [
      id,
      c.code,
      c.farePaise,
      c.berthLabels,
    ]);
  }
  return id;
}

// Trips from → to (any letter case) on `date` (a calendar day in `timeZone`), not departed, not
// cancelled; optionally only trips offering one class.
export async function searchTrips(client, { from, to, date, timeZone, classCode = null }) {
  const { rows } = await client.query(
    `SELECT t.*, ${CLASSES_JSON}
       FROM train_trips AS t
      WHERE lower(t.origin) = lower($1) AND lower(t.destination) = lower($2)
        AND t.departs_at >= ($3::date)::timestamp AT TIME ZONE $4
        AND t.departs_at <  ($3::date + 1)::timestamp AT TIME ZONE $4
        AND t.departs_at > now() AND t.cancelled_at IS NULL
        AND ($5::text IS NULL OR EXISTS (SELECT 1 FROM train_trip_classes c2 WHERE c2.trip_id = t.id AND c2.class_code = $5::text))
      ORDER BY t.departs_at, t.id`,
    [from, to, date, timeZone, classCode],
  );
  return rows.map(toTrip);
}

export async function listUpcomingTrips(client) {
  const { rows } = await client.query(
    `SELECT t.*, ${CLASSES_JSON} FROM train_trips AS t WHERE t.departs_at > now() - interval '1 day' ORDER BY t.departs_at, t.id LIMIT 200`,
  );
  return rows.map(toTrip);
}

// The trip with its classes' availability. { lock: true } = SELECT … FOR UPDATE on the trip row:
// every booking change on a trip takes this lock FIRST (lock order: trip, then booking).
export async function findTrip(client, id, { lock = false } = {}) {
  if (lock) await client.query('SELECT id FROM train_trips WHERE id = $1 FOR UPDATE', [id]);
  const { rows } = await client.query(`SELECT t.*, ${CLASSES_JSON} FROM train_trips AS t WHERE t.id = $1`, [id]);
  return rows[0] ? toTrip(rows[0]) : null;
}

// One class of a trip: its fare and its berths, in allocation order.
export async function findClass(client, tripId, classCode) {
  const { rows } = await client.query('SELECT fare_paise, berth_labels FROM train_trip_classes WHERE trip_id = $1 AND class_code = $2', [
    tripId,
    classCode,
  ]);
  return rows[0] ? { farePaise: rows[0].fare_paise, berthLabels: rows[0].berth_labels } : null;
}

export async function takenBerths(client, tripId) {
  const { rows } = await client.query(
    `SELECT x.berth_label FROM train_booking_berths AS x JOIN train_bookings AS b ON b.id = x.booking_id
      WHERE x.trip_id = $1 AND ${TAKEN}`,
    [tripId],
  );
  return new Set(rows.map((r) => r.berth_label));
}

// Holds past their time become 'expired' and give their berths back.
export async function expireOverdueHolds(client, tripId) {
  const { rows } = await client.query(
    `UPDATE train_bookings SET status = 'expired', updated_at = now()
      WHERE trip_id = $1 AND status = 'held' AND held_until <= now() RETURNING id`,
    [tripId],
  );
  if (rows.length) {
    await client.query('UPDATE train_booking_berths SET active = false WHERE booking_id = ANY($1::bigint[])', [rows.map((r) => r.id)]);
  }
  return rows.length;
}

export async function insertBooking(client, { tripId, userId, classCode, berths, amountPaise, idempotencyKey, holdMinutes }) {
  const { rows } = await client.query(
    `INSERT INTO train_bookings (trip_id, user_id, class_code, amount_paise, idempotency_key, held_until)
     VALUES ($1, $2, $3, $4, $5, now() + make_interval(mins => $6)) RETURNING id`,
    [tripId, userId, classCode, amountPaise, idempotencyKey, holdMinutes],
  );
  const id = Number(rows[0].id);
  await client.query(
    `INSERT INTO train_booking_berths (booking_id, trip_id, berth_label, position)
     SELECT $1, $2, b.label, b.pos FROM unnest($3::text[]) WITH ORDINALITY AS b(label, pos)`,
    [id, tripId, berths],
  );
  return id;
}

const BOOKING_SELECT = `
  SELECT b.*, t.train_number, t.train_name, t.origin, t.destination, t.departs_at, t.arrives_at,
         (t.cancelled_at IS NOT NULL) AS trip_cancelled,
         json_agg(json_build_object('berth', x.berth_label, 'position', x.position, 'name', x.passenger_name,
                                    'age', x.passenger_age, 'gender', x.passenger_gender) ORDER BY x.position) AS berths
    FROM train_bookings AS b
    JOIN train_trips AS t ON t.id = b.trip_id
    JOIN train_booking_berths AS x ON x.booking_id = b.id`;

function toBooking(r) {
  return {
    id: Number(r.id),
    userId: Number(r.user_id),
    tripId: Number(r.trip_id),
    classCode: r.class_code,
    status: r.status,
    pnr: r.pnr,
    amountPaise: r.amount_paise,
    heldUntil: r.held_until,
    contactPhone: r.contact_phone,
    confirmedAt: r.confirmed_at,
    cancelledAt: r.cancelled_at,
    createdAt: r.created_at,
    trip: {
      id: Number(r.trip_id),
      trainNumber: r.train_number,
      trainName: r.train_name,
      from: r.origin,
      to: r.destination,
      departsAt: r.departs_at,
      arrivesAt: r.arrives_at,
      cancelled: r.trip_cancelled,
    },
    berths: r.berths,
  };
}

// Ownership is part of the query: someone else's booking simply isn't found (→ 404).
export async function findBooking(client, id, userId, { lock = false } = {}) {
  if (lock) await client.query('SELECT id FROM train_bookings WHERE id = $1 AND user_id = $2 FOR UPDATE', [id, userId]);
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

export async function confirmBooking(client, { id, passengers, contactPhone, pnr }) {
  await client.query(
    `UPDATE train_booking_berths AS x SET passenger_name = p.name, passenger_age = p.age, passenger_gender = p.gender
       FROM json_to_recordset($2::json) AS p(position int, name text, age int, gender text)
      WHERE x.booking_id = $1 AND x.position = p.position`,
    [id, JSON.stringify(passengers.map((p, i) => ({ ...p, position: i + 1 })))],
  );
  await client.query(
    `UPDATE train_bookings SET status = 'confirmed', pnr = $3, contact_phone = $2, confirmed_at = now(), updated_at = now() WHERE id = $1`,
    [id, contactPhone ?? null, pnr],
  );
}

export async function cancelBooking(client, id) {
  await client.query(`UPDATE train_bookings SET status = 'cancelled', cancelled_at = now(), updated_at = now() WHERE id = $1`, [id]);
  await client.query('UPDATE train_booking_berths SET active = false WHERE booking_id = $1', [id]);
}
