/**
 * Sliding Window Log rate limiter.
 *
 * Semantics: keeps a timestamped log of every accepted request in the last
 * `windowSeconds`. On each new request: drop entries older than the window,
 * count what's left, allow if under the limit. This is the most accurate
 * algorithm (no burst-at-boundary problem like fixed windows have) but costs
 * more memory since every request timestamp is stored.
 *
 * Atomicity: trimming old entries, counting, and inserting the new entry
 * must happen as one unit, or two concurrent requests can both count the
 * same "under limit" state and both get allowed past the limit.
 */

const REDIS_KEY_PREFIX = "rl:swl:";

const SLIDING_WINDOW_LOG_SCRIPT = `
local key = KEYS[1]
local now_ms = tonumber(ARGV[1])
local window_ms = tonumber(ARGV[2])
local limit = tonumber(ARGV[3])
local member = ARGV[4]

local window_start = now_ms - window_ms

redis.call("ZREMRANGEBYSCORE", key, "-inf", window_start)

local current_count = redis.call("ZCARD", key)

local allowed = 0
if current_count < limit then
  redis.call("ZADD", key, now_ms, member)
  allowed = 1
  current_count = current_count + 1
end

redis.call("PEXPIRE", key, window_ms)

return {allowed, current_count}
`;

let scriptSha = null;

async function loadScript(redis) {
  if (!scriptSha) {
    scriptSha = await redis.script("LOAD", SLIDING_WINDOW_LOG_SCRIPT);
  }
  return scriptSha;
}

/**
 * @param redis ioredis client
 * @param identifier unique id for the caller, e.g. the API key
 * @param opts { limit: number, windowSeconds: number }
 * @returns { allowed: boolean, remaining: number }
 */
async function consume(redis, identifier, opts) {
  const { limit, windowSeconds } = opts;
  if (!limit || !windowSeconds) {
    throw new Error("slidingWindowLog.consume requires limit and windowSeconds");
  }

  const key = `${REDIS_KEY_PREFIX}${identifier}`;
  const now = Date.now();
  const windowMs = windowSeconds * 1000;
  // unique member per request so concurrent requests at the same millisecond
  // don't collide in the sorted set (ZADD would just overwrite the score)
  const member = `${now}-${Math.random().toString(36).slice(2, 10)}`;

  const sha = await loadScript(redis);
  let result;
  try {
    result = await redis.evalsha(sha, 1, key, now, windowMs, limit, member);
  } catch (err) {
    if (err.message && err.message.includes("NOSCRIPT")) {
      scriptSha = null;
      const freshSha = await loadScript(redis);
      result = await redis.evalsha(freshSha, 1, key, now, windowMs, limit, member);
    } else {
      throw err;
    }
  }

  const [allowed, count] = result;
  return {
    allowed: allowed === 1,
    remaining: Math.max(0, limit - Number(count)),
  };
}

module.exports = { consume };
