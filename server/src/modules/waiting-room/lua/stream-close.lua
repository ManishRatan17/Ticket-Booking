-- Give a live-stream slot back (Phase 5c). Deletes the counter at 0, so it can never go
-- negative (a DECR on a key that already expired would otherwise leave -1 forever).
--
-- KEYS[1] = <prefix>:streams:<userId>
local count = redis.call('DECR', KEYS[1])
if count <= 0 then
  redis.call('DEL', KEYS[1])
end
return count
