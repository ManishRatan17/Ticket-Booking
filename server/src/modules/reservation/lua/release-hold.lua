-- Release a hold: give its tickets back and delete it, in ONE step.
-- IDEMPOTENT: releasing the same hold twice returns its tickets ONCE. That matters because
-- the user ("Release" button), the payment flow (Phase 2) and the expiry worker (Phase 3)
-- may all try to release the same hold, possibly at the same moment.
--
-- KEYS[1] = hold:<holdId>
-- ARGV[1] = holdId
-- ARGV[2] = userId of the person asking, or '' for the system (expiry worker)
--
-- Returns: 1 released · 0 no such hold (already released / expired and cleaned up) · -1 not yours

local fields = redis.call('HMGET', KEYS[1], 'userId', 'eventId', 'quantity', 'pool')
local ownerId, eventId, quantity, pool = fields[1], fields[2], fields[3], fields[4]
if not quantity then
  return 0
end
if ARGV[2] ~= '' and ownerId ~= ARGV[2] then
  return -1
end

-- Tickets go back to the POOL they came from (lucky draw, Phase "lucky draw"): a lucky-draw
-- hold returns to the lucky-draw stock — unless the draw is over, then to the normal sale.
local stockKey = 'event:' .. eventId .. ':stock'
if pool == 'lottery' and redis.call('EXISTS', 'event:' .. eventId .. ':lottery-closed') == 0 then
  stockKey = 'event:' .. eventId .. ':lottery-stock'
end
local userHoldKey = 'event:' .. eventId .. ':user:' .. ownerId .. ':hold'

-- If the stock key is gone (Redis lost its data), it will be rebuilt from Postgres instead.
if redis.call('EXISTS', stockKey) == 1 then
  redis.call('INCRBY', stockKey, quantity)
end
redis.call('DEL', KEYS[1])
redis.call('ZREM', 'holds:by-expiry', ARGV[1])
-- Only unlink the user if the link still points at THIS hold.
if redis.call('GET', userHoldKey) == ARGV[1] then
  redis.call('DEL', userHoldKey)
end
return 1
