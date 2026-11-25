-- Consume a hold: it was PAID for, so its tickets are sold — delete the hold WITHOUT giving its
-- tickets back to stock (the opposite of release-hold.lua, which returns them).
-- Works even if the hold's time has passed: if the record still exists, its tickets were
-- still set aside, so a payment that arrives a little late can still use them.
--
-- KEYS[1] = hold:<holdId>
-- ARGV[1] = holdId
-- Returns 1 consumed · 0 no such hold (already released, consumed or never existed)
--
-- Also adds the hold's tickets to the owner's 'bought' count (Phase 5b purchase cap), in the
-- same atomic step: there is no moment where the hold is gone but not yet counted as bought.

local fields = redis.call('HMGET', KEYS[1], 'userId', 'eventId', 'quantity')
local ownerId, eventId, quantity = fields[1], fields[2], fields[3]
if not eventId then
  return 0
end

redis.call('DEL', KEYS[1])
redis.call('ZREM', 'holds:by-expiry', ARGV[1])
local userHoldKey = 'event:' .. eventId .. ':user:' .. ownerId .. ':hold'
if redis.call('GET', userHoldKey) == ARGV[1] then
  redis.call('DEL', userHoldKey)
end
redis.call('INCRBY', 'event:' .. eventId .. ':user:' .. ownerId .. ':bought', quantity)
return 1
