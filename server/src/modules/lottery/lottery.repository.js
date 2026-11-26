// SQL for the lucky draw (migration 008). Functions take a `client` (the pool, or a transaction).

export async function createDraw(client, { eventId, seed, seedHash }) {
  await client.query('INSERT INTO lottery_draws (event_id, seed, seed_hash) VALUES ($1, $2, $3)', [eventId, seed, seedHash]);
}

// The draw row, LOCKED until the transaction ends: two workers can't run the same round twice.
// Also "now" from the same database, and when the draw is due.
export async function lockDraw(client, eventId) {
  const { rows } = await client.query(
    `SELECT d.seed, d.seed_hash, d.drawn_at, d.rounds_done, d.last_round_at, now() AS now,
            e.sale_starts_at + make_interval(mins => e.lottery_draw_minutes) AS draw_at
       FROM lottery_draws AS d JOIN events AS e ON e.id = d.event_id
      WHERE d.event_id = $1
        FOR UPDATE OF d`,
    [eventId],
  );
  if (rows.length === 0) return null;
  const r = rows[0];
  return {
    seed: r.seed,
    seedHash: r.seed_hash,
    drawnAt: r.drawn_at,
    roundsDone: r.rounds_done,
    lastRoundAt: r.last_round_at,
    now: r.now,
    drawAt: r.draw_at,
  };
}

// Events (not cancelled) whose draw is open and due (the draw time has come). Optionally only some (tests).
export async function dueDrawEventIds(client, eventIds = null) {
  const { rows } = await client.query(
    `SELECT e.id FROM events AS e JOIN lottery_draws AS d ON d.event_id = e.id
      WHERE e.lottery_closed_at IS NULL AND e.cancelled_at IS NULL -- a cancelled event draws nobody
        AND e.sale_starts_at + make_interval(mins => e.lottery_draw_minutes) <= now()
        AND ($1::bigint[] IS NULL OR e.id = ANY($1::bigint[]))`,
    [eventIds],
  );
  return rows.map((r) => Number(r.id));
}

// Freeze the entrants with their draw numbers (one INSERT for all of them), and reveal the seed.
export async function freezeEntrants(client, eventId, entries) {
  if (entries.length > 0) {
    await client.query(
      `INSERT INTO lottery_entries (event_id, user_id, draw_number)
       SELECT $1, unnest($2::bigint[]), unnest($3::text[])
       ON CONFLICT DO NOTHING`,
      [eventId, entries.map((e) => e.userId), entries.map((e) => e.drawNumber)],
    );
  }
  await client.query('UPDATE lottery_draws SET drawn_at = now(), entrants = $2 WHERE event_id = $1', [eventId, entries.length]);
}

// The next `count` entrants in draw order who haven't won yet and may still buy (under the
// per-person purchase cap). Their draw numbers decide; nothing else does.
export async function nextWinners(client, { eventId, count, maxPerUser }) {
  const { rows } = await client.query(
    `SELECT en.user_id
       FROM lottery_entries AS en
      WHERE en.event_id = $1
        AND NOT EXISTS (SELECT 1 FROM lottery_winners AS w WHERE w.event_id = en.event_id AND w.user_id = en.user_id)
        AND (SELECT COALESCE(SUM(o.quantity), 0) FROM orders AS o
              WHERE o.event_id = en.event_id AND o.user_id = en.user_id AND o.status = 'paid') < $3
      ORDER BY en.draw_number
      LIMIT $2`,
    [eventId, count, maxPerUser],
  );
  return rows.map((r) => Number(r.user_id));
}

export async function insertWinners(client, { eventId, userIds, round, passSeconds }) {
  await client.query(
    `INSERT INTO lottery_winners (event_id, user_id, round, pass_expires_at)
     SELECT $1, unnest($2::bigint[]), $3, now() + make_interval(secs => $4)`,
    [eventId, userIds, round, passSeconds],
  );
}

export async function finishRound(client, eventId, round) {
  await client.query('UPDATE lottery_draws SET rounds_done = $2, last_round_at = now() WHERE event_id = $1', [eventId, round]);
}

export async function markClosed(client, eventId) {
  await client.query('UPDATE events SET lottery_closed_at = now() WHERE id = $1', [eventId]);
}

// Everything a person's page needs about the draw, in one query.
export async function drawForUser(client, eventId, userId) {
  const { rows } = await client.query(
    `SELECT d.seed, d.seed_hash, d.drawn_at, d.entrants, d.rounds_done,
            en.draw_number, w.round AS won_round, w.pass_expires_at,
            (SELECT count(*)::int FROM lottery_winners AS w2 WHERE w2.event_id = d.event_id) AS winners
       FROM lottery_draws AS d
       LEFT JOIN lottery_entries AS en ON en.event_id = d.event_id AND en.user_id = $2
       LEFT JOIN lottery_winners AS w ON w.event_id = d.event_id AND w.user_id = $2
      WHERE d.event_id = $1`,
    [eventId, userId],
  );
  return rows[0] ?? null;
}
