-- Close an event's lucky draw: its leftover tickets go back to the normal sale. One atomic step,
-- so no hold can slip in between "how many are left?" and "move them".
--
-- KEYS[1] = event:<id>:lottery-stock
-- KEYS[2] = event:<id>:stock
-- KEYS[3] = event:<id>:lottery-closed
-- Returns how many tickets moved (0 if already closed: running it twice is harmless).
--
-- After this, release-hold.lua sends any lucky-draw hold that is released LATER (a winner who
-- doesn't pay) to the normal stock too, because the "closed" flag exists.

if redis.call('EXISTS', KEYS[3]) == 1 then
  return 0
end
local left = tonumber(redis.call('GET', KEYS[1])) or 0
if left > 0 and redis.call('EXISTS', KEYS[2]) == 1 then
  redis.call('INCRBY', KEYS[2], left)
end
redis.call('SET', KEYS[1], 0)
redis.call('SET', KEYS[3], '1')
return left
