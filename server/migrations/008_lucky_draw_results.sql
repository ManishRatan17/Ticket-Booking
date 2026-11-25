-- 008: the LUCKY DRAW (part 2: the draw itself). See docs/16-lucky-draw.md.

-- One row per event with a draw. COMMIT–REVEAL: seed_hash = sha256(seed) is public from the moment
-- the event exists; the seed itself is shown only after the draw. Anyone can then check that the
-- revealed seed matches the hash published in advance, so it can't have been changed afterwards
-- (for example after seeing who entered).
CREATE TABLE lottery_draws (
  event_id      BIGINT      PRIMARY KEY REFERENCES events(id) ON DELETE CASCADE,
  seed          TEXT        NOT NULL,          -- 32 random bytes, hex: secret until the draw
  seed_hash     TEXT        NOT NULL,          -- sha256(seed), hex: public from the start
  drawn_at      TIMESTAMPTZ,                   -- round 1: entrants frozen, seed revealed
  entrants      INTEGER,                       -- how many were entered
  rounds_done   INTEGER     NOT NULL DEFAULT 0,
  last_round_at TIMESTAMPTZ,                   -- the next round (or closing) waits one round length after this
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Everyone entered, frozen at the draw. draw_number = HMAC-SHA256(seed, "<eventId>:<userId>"), hex:
-- the LOWEST numbers win first. Deterministic: the same seed and entrants always give the same order.
CREATE TABLE lottery_entries (
  event_id    BIGINT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  user_id     BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  draw_number TEXT   NOT NULL,
  PRIMARY KEY (event_id, user_id)                -- one entry per account
);
CREATE INDEX lottery_entries_order_idx ON lottery_entries (event_id, draw_number);

-- Winners, by round. The primary key makes "nobody wins twice" a database rule.
CREATE TABLE lottery_winners (
  event_id        BIGINT      NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  user_id         BIGINT      NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  round           INTEGER     NOT NULL,
  pass_expires_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (event_id, user_id)
);
