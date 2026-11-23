-- 005: waiting room (Phase 4).
-- NULL  = no waiting room: anyone signed in can hold tickets as soon as the sale opens.
-- N > 0 = a waiting room: people queue up, and N people per second are let in (given a pass).
ALTER TABLE events
  ADD COLUMN admission_per_second INTEGER CHECK (admission_per_second > 0);
