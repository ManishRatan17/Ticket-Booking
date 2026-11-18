-- Fixed-window rate limit counter: "at most N hits per window".
-- INCR and EXPIRE run as ONE step. If they were two separate commands and the server
-- crashed between them, the counter would exist with NO expiry — that client would
-- stay blocked forever.
--
-- KEYS[1] = counter key, e.g. "ratelimit:login-ip:<hash>"
-- ARGV[1] = window length in seconds
-- Returns { count after this hit, seconds until the window resets }

local count = redis.call('INCR', KEYS[1])
if count == 1 then
  redis.call('EXPIRE', KEYS[1], ARGV[1]) -- first hit of a new window starts the clock
end
return { count, redis.call('TTL', KEYS[1]) }
