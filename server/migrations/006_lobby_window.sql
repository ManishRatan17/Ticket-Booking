-- 006: the waiting room's LOBBY WINDOW.
-- How many minutes before the sale the waiting room opens. Joining earlier is refused, so nobody
-- (person or bot) can take a place days ahead. Only used by events with a waiting room.
ALTER TABLE events
  ADD COLUMN lobby_minutes INTEGER NOT NULL DEFAULT 15 CHECK (lobby_minutes BETWEEN 1 AND 1440);
