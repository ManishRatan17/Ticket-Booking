-- Atomically reserve tickets from an event's stock.
-- Redis runs this whole script as ONE step: no other command can run in the middle,
-- so the CHECK and the ACT can never be separated by another buyer.
--
-- KEYS[1] = stock key, e.g. "event:1:stock"
-- ARGV[1] = quantity to reserve
-- Returns:  1 = reserved,  0 = not enough tickets,  -1 = no stock key (sale not set up)

local stock = tonumber(redis.call('GET', KEYS[1]))
if stock == nil then
  return -1
end

local quantity = tonumber(ARGV[1])
if stock < quantity then
  return 0
end

redis.call('DECRBY', KEYS[1], quantity)
return 1
