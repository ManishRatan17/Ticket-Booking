-- Join an event's waiting room — or report where you already are. One atomic step.
--
-- KEYS[1] = wr:<eventId>:queue        sorted set: member = user id, score = arrival number
-- KEYS[2] = wr:<eventId>:seq          counter that hands out arrival numbers (1, 2, 3, …)
-- KEYS[3] = wr:<eventId>:pass:<user>  exists while this user is admitted
-- KEYS[4] = wr:active                 set of event ids whose waiting room has people in it
-- ARGV    = userId, eventId, lobbyOpensAtMs
--
-- Returns { 'admitted', secondsLeftOnPass }
--      or { 'waiting', position (1 = next), total in queue }
--      or { 'not_open' }   the waiting room hasn't opened yet (nothing changed)

local passTtl = redis.call('TTL', KEYS[3])
if passTtl > 0 then
  return { 'admitted', passTtl }
end

-- Already in the queue (second tab, page reload, double click)? Keep the ORIGINAL place.
if not redis.call('ZSCORE', KEYS[1], ARGV[1]) then
  -- The lobby window: nobody joins before it opens. Redis's own clock decides, so every server
  -- (and every visitor) gets the same answer at the same moment.
  local t = redis.call('TIME')
  local nowMs = tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000)
  if nowMs < tonumber(ARGV[3]) then
    return { 'not_open' }
  end

  -- Only a first-time join gets a new arrival number, so the order is first come, first served.
  local arrival = redis.call('INCR', KEYS[2])
  redis.call('ZADD', KEYS[1], arrival, ARGV[1])
  redis.call('SADD', KEYS[4], ARGV[2]) -- tell the admission worker this room needs attention
end

return { 'waiting', redis.call('ZRANK', KEYS[1], ARGV[1]) + 1, redis.call('ZCARD', KEYS[1]) }
