/**
 * Token Bucket rate limiter.
 *
 * Semantics: a bucket holds up to `capacity` tokens. Tokens refill continuously
 * at `refillRatePerSec`. Each request consumes 1 token; if none are available,
 * the request is denied. This allows short bursts up to `capacity` while
 * enforcing a steady-state average rate.
 *
 * Why Lua: without it, "read tokens -> compute refill -> compare -> write" is
 * four separate round trips, and two concurrent requests can both read the
 * same stale token count and both get allowed when only one should. The Lua
 * script runs atomically inside Redis's single-threaded execution, so this
 * race can't happen no matter how many app server instances call it at once.
 */

const REDIS_KEY_PREFIX = "rl:tb:";

const TOKEN_BUCKET_SCRIPT = `
local key = KEYS[1]
local capacity = tonumber(ARGV[1])
local refill_rate_per_sec = tonumber(ARGV[2])
local now_ms = tonumber(ARGV[3])
local requested = 1

local bucket = redis.call("HMGET", key, "tokens", "last_refill_ms")
local tokens = tonumber(bucket[1])
local last_refill_ms = tonumber(bucket[2])

if tokens == nil then
  tokens = capacity
  last_refill_ms = now_ms
end

local elapsed_sec = math.max(0, (now_ms - last_refill_ms) / 1000)
local refill = elapsed_sec * refill_rate_per_sec
tokens = math.min(capacity, tokens + refill)

local allowed = 0
if tokens >= requested then
  tokens = tokens - requested
  allowed = 1
end

redis.call("HMSET", key, "tokens", tokens, "last_refill_ms", now_ms)
-- expire the key well after it would naturally refill to full, so idle
-- keys don't sit in Redis forever
local ttl_sec = math.ceil(capacity / refill_rate_per_sec) + 60
redis.call("EXPIRE", key, ttl_sec)

return {allowed, tokens}
`;

let scriptSha = null;

async function loadScript(redis) {
  if (!scriptSha) {
    scriptSha = await redis.script("LOAD", TOKEN_BUCKET_SCRIPT);
  }
  return scriptSha;
}

/**
 * @param redis ioredis client
 * @param identifier unique id for the caller, e.g. the API key
 * @param opts { capacity: number, refillRatePerSec: number }
 * @returns { allowed: boolean, remaining: number }
 */
async function consume(redis, identifier, opts) {
  const { capacity, refillRatePerSec } = opts;
  if (!capacity || !refillRatePerSec) {
    throw new Error("tokenBucket.consume requires capacity and refillRatePerSec");
  }

  const key = `${REDIS_KEY_PREFIX}${identifier}`;
  const now = Date.now();

  const sha = await loadScript(redis);
  let result;
  try {
    result = await redis.evalsha(sha, 1, key, capacity, refillRatePerSec, now);
  } catch (err) {
    // NOSCRIPT can happen after a Redis restart flushes the script cache
    if (err.message && err.message.includes("NOSCRIPT")) {
      scriptSha = null;
      const freshSha = await loadScript(redis);
      result = await redis.evalsha(freshSha, 1, key, capacity, refillRatePerSec, now);
    } else {
      throw err;
    }
  }

  const [allowed, tokensRemaining] = result;
  return {
    allowed: allowed === 1,
    remaining: Math.floor(Number(tokensRemaining)),
  };
}

module.exports = { consume };
