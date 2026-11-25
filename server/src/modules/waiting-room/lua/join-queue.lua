-- Join an event's waiting room — or report where you already are. One atomic step.
--
-- KEYS[1] = wr:<eventId>:queue        sorted set: member = user id, score = place in line (lowest first)
-- KEYS[2] = wr:<eventId>:seq          counter that hands out arrival numbers (1, 2, 3, …)
-- KEYS[3] = wr:<eventId>:pass:<user>  exists while this user is admitted
-- KEYS[4] = wr:active                 set of event ids whose waiting room has people in it
-- KEYS[5] = wr:<eventId>:entrants     everyone who joined (the lucky draw's entrants)
-- ARGV    = userId, eventId, lobbyOpensAtMs, saleStartsAtMs, drawScore (a random number in [0, 1)),
--           hasLuckyDraw ('1' = this event has a lucky draw)
--
-- Returns { 'admitted', secondsLeftOnPass }
--      or { 'lobby', people in the lobby }              before the sale: your place isn't shown yet
--      or { 'waiting', position (1 = next), total in queue }
--      or { 'not_open' }   the waiting room hasn't opened yet (nothing changed)
--
-- THE FAIR DRAW (hybrid order). The score decides the order (ZPOPMIN admits the lowest first):
--   • joined in the LOBBY (before the sale)   → score = drawScore, a RANDOM number in [0, 1)
--   • joined AFTER the sale opened            → score = arrival number 1, 2, 3, … (always ≥ 1)
-- So everyone in the lobby is in random order among themselves — joining at 10:45:00 or at 10:59
-- gives the same chance, so there's no point refreshing (or running a bot) at the exact second —
-- and everyone in the lobby is ahead of everyone who came after the sale opened.
-- The random number comes from Node's crypto module (a proper random source), not Lua's math.random.

local passTtl = redis.call('TTL', KEYS[3])
if passTtl > 0 then
  return { 'admitted', passTtl }
end

-- Redis's own clock: every server (and every visitor) gets the same answer at the same moment.
local t = redis.call('TIME')
local nowMs = tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000)
local inLobby = nowMs < tonumber(ARGV[4])

-- Already in the queue (second tab, page reload, double click)? Keep the ORIGINAL place:
-- re-joining never gives you a new draw.
if not redis.call('ZSCORE', KEYS[1], ARGV[1]) then
  -- The lobby window: nobody joins before it opens.
  if nowMs < tonumber(ARGV[3]) then
    return { 'not_open' }
  end

  local score
  if inLobby then
    score = ARGV[5]
  else
    score = redis.call('INCR', KEYS[2])
  end
  redis.call('ZADD', KEYS[1], score, ARGV[1])
  redis.call('SADD', KEYS[4], ARGV[2]) -- tell the admission worker this room needs attention
end

-- Lucky draw: joining the waiting room = being entered (once: it's a set). Kept even after
-- you're let in, so people who joined early aren't punished for having been admitted.
if ARGV[6] == '1' then
  redis.call('SADD', KEYS[5], ARGV[1])
end

if inLobby then
  return { 'lobby', redis.call('ZCARD', KEYS[1]) }
end
return { 'waiting', redis.call('ZRANK', KEYS[1], ARGV[1]) + 1, redis.call('ZCARD', KEYS[1]) }
