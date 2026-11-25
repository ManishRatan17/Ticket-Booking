-- Create a ticket hold: check and reserve in ONE step that nothing can interrupt.
--
-- KEYS[1] = event:<eventId>:stock                 tickets still available
-- KEYS[2] = event:<eventId>:user:<userId>:hold    which hold this user has for this event
-- KEYS[3] = hold:<newHoldId>                      the hold record to create
-- KEYS[4] = event:<eventId>:user:<userId>:bought  tickets this user has already PAID for (Phase 5b)
-- ARGV    = holdId, userId, eventId, quantity, holdSeconds, maxTicketsPerUser
--
-- Returns:
--   { 1, expiresAtMs }        held
--   { 0, ticketsLeft }        not enough tickets (nothing changed)
--   { -1 }                    no stock key: the event's stock was never loaded
--   { -2, existingHoldId }    this user already has an ACTIVE hold for this event
--   { -3, alreadyBought }     bought + this hold would go over the per-person limit (nothing changed)
--
-- Also keeps the index 'holds:by-expiry' (a sorted set: member = hold id, score = expiresAt)
-- up to date in the SAME atomic step, so it can never disagree with the holds themselves.
--
-- ⚠️ Key names built inside the script ('hold:' .. id, 'event:' ..., 'holds:by-expiry') must match holds.js / stock.js.
-- (Redis Cluster would want every key declared in KEYS; fine on a single Redis — see Phase 8.)

-- Redis's own clock: the server and Redis can never disagree about "now".
local t = redis.call('TIME')
local nowMs = tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000)

local stock = tonumber(redis.call('GET', KEYS[1]))
if stock == nil then
  return { -1 }
end

-- One hold per user per event. If their previous hold has EXPIRED (or the link is stale),
-- release it right here ("lazy expiry") so nobody is blocked by their own old hold.
local existingId = redis.call('GET', KEYS[2])
if existingId then
  local existingKey = 'hold:' .. existingId
  local fields = redis.call('HMGET', existingKey, 'quantity', 'expiresAt')
  local oldQuantity = tonumber(fields[1])
  local oldExpiresAt = tonumber(fields[2])
  if oldQuantity and oldExpiresAt and oldExpiresAt > nowMs then
    return { -2, existingId }
  end
  if oldQuantity then
    redis.call('INCRBY', KEYS[1], oldQuantity) -- the expired hold's tickets go back on sale
    stock = stock + oldQuantity
  end
  redis.call('DEL', existingKey, KEYS[2])
  redis.call('ZREM', 'holds:by-expiry', existingId)
end

local quantity = tonumber(ARGV[4])

-- Purchase cap (Phase 5b): tickets already bought + this hold must stay within the limit.
-- Checked in the SAME atomic step as the hold, so two quick holds can't both slip under it.
local bought = tonumber(redis.call('GET', KEYS[4])) or 0
if bought + quantity > tonumber(ARGV[6]) then
  return { -3, bought }
end

if stock < quantity then
  return { 0, stock }
end

local expiresAt = nowMs + tonumber(ARGV[5]) * 1000
redis.call('DECRBY', KEYS[1], quantity)
redis.call('HSET', KEYS[3],
  'userId', ARGV[2],
  'eventId', ARGV[3],
  'quantity', quantity,
  'createdAt', nowMs,
  'expiresAt', expiresAt)
redis.call('SET', KEYS[2], ARGV[1])
redis.call('ZADD', 'holds:by-expiry', expiresAt, ARGV[1])
return { 1, expiresAt }
