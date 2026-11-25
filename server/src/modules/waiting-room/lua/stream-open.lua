-- Take one of a user's live-stream slots (Phase 5c: at most N open queue streams per user).
--
-- KEYS[1] = <prefix>:streams:<userId>   how many streams this user has open right now
-- ARGV    = maxStreams, ttlSeconds
-- Returns 1 = slot taken · 0 = all slots in use (nothing changed)
--
-- Count first, then decide — in one atomic step, so 10 tabs opening at the same instant get
-- counts 1..10 and exactly maxStreams of them pass. A refused open gives its count back.
-- The TTL is a safety net: if a server crashes, its open streams can't close (no DECR), and
-- their slots would be taken forever. With a TTL longer than a stream may live, they free up.
local count = redis.call('INCR', KEYS[1])
redis.call('EXPIRE', KEYS[1], tonumber(ARGV[2]))
if count > tonumber(ARGV[1]) then
  redis.call('DECR', KEYS[1])
  return 0
end
return 1
