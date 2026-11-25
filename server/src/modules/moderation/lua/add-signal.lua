-- Add one bot signal to a person's suspicion score. One atomic step.
--
-- KEYS[1] = <prefix>:score:<userId>     points in the current window
-- KEYS[2] = <prefix>:signals:<userId>   hash: signal kind → how many times (the EVIDENCE)
-- KEYS[3] = <prefix>:flagged:<userId>   set once the threshold is crossed in this window
-- ARGV    = points, kind, windowSeconds, threshold
-- Returns { score, 1 } the FIRST time the score reaches the threshold in a window (→ a strike),
--         { score, 0 } otherwise.
--
-- The window starts with the first signal and is NOT extended by later ones: points fade away
-- together after windowSeconds. "Count, then decide" in one step (like the rate limiter), and the
-- SET NX makes sure two signals arriving together can't both trigger a strike.

local score = redis.call('INCRBY', KEYS[1], tonumber(ARGV[1]))
if redis.call('TTL', KEYS[1]) < 0 then
  redis.call('EXPIRE', KEYS[1], tonumber(ARGV[3]))
end
redis.call('HINCRBY', KEYS[2], ARGV[2], 1)
if redis.call('TTL', KEYS[2]) < 0 then
  redis.call('EXPIRE', KEYS[2], tonumber(ARGV[3]))
end

if score >= tonumber(ARGV[4]) and redis.call('SET', KEYS[3], '1', 'NX', 'EX', tonumber(ARGV[3])) then
  return { score, 1 }
end
return { score, 0 }
