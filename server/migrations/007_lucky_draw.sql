-- 007: the LUCKY DRAW (part 1: settings and a separate pool of tickets).
-- An admin can set aside part of an event's tickets (0–50 %). Those are not sold first come,
-- first served: they're given away by a random draw among everyone in the waiting room.
ALTER TABLE events
  ADD COLUMN lottery_percent      INTEGER NOT NULL DEFAULT 0  CHECK (lottery_percent BETWEEN 0 AND 50),
  -- floor(total × percent ÷ 100), fixed when the event is created
  ADD COLUMN lottery_tickets      INTEGER NOT NULL DEFAULT 0  CHECK (lottery_tickets >= 0),
  -- the draw happens this many minutes after the sale opens
  ADD COLUMN lottery_draw_minutes INTEGER NOT NULL DEFAULT 30 CHECK (lottery_draw_minutes BETWEEN 1 AND 1440),
  -- each winner may buy up to this many lucky-draw tickets
  ADD COLUMN lottery_per_winner   INTEGER NOT NULL DEFAULT 2  CHECK (lottery_per_winner BETWEEN 1 AND 4),
  -- set when the draw is over and its leftover tickets went back to the normal sale
  ADD COLUMN lottery_closed_at    TIMESTAMPTZ,
  ADD CONSTRAINT events_lottery_within_total CHECK (lottery_tickets <= total_tickets);

-- Which pool an order's tickets came from. Needed to rebuild each pool's stock from PostgreSQL.
ALTER TABLE orders
  ADD COLUMN pool TEXT NOT NULL DEFAULT 'main' CHECK (pool IN ('main', 'lottery'));
