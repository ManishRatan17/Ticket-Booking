-- Let the next N people in. One atomic step, so two admission runs at the same moment can't
-- admit the same person twice or skip anyone.
--
-- KEYS[1] = <prefix>:<eventId>:queue
-- KEYS[2] = <prefix>:active        set of event ids whose waiting room has people in it
-- ARGV    = eventId, N (how many to admit now), pass lifetime in seconds, key prefix ("wr")
-- Returns the user ids admitted, in queue order.

local admitted = redis.call('ZPOPMIN', KEYS[1], tonumber(ARGV[2])) -- lowest arrival numbers first
local ids = {}
for i = 1, #admitted, 2 do -- ZPOPMIN returns member, score, member, score, …
  local userId = admitted[i]
  redis.call('SET', ARGV[4] .. ':' .. ARGV[1] .. ':pass:' .. userId, '1', 'EX', tonumber(ARGV[3]))
  table.insert(ids, userId)
end

-- Empty now? Stop checking this room — decided in the SAME step as the pop. Done separately,
-- someone could join between "is it empty?" and "stop checking", and wait forever.
if redis.call('ZCARD', KEYS[1]) == 0 then
  redis.call('SREM', KEYS[2], ARGV[1])
end
return ids
