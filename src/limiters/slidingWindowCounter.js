/**
 * Sliding Window Counter rate limiter (approximation).
 *
 * Semantics: time is divided into fixed buckets of `windowSeconds`. We track
 * a simple counter for the current bucket and the previous bucket, then
 * estimate the "true" sliding count as:
 *
 *   estimated = previous_bucket_count * overlap_weight + current_bucket_count
 *
 * where overlap_weight is how much of the previous bucket still falls inside
 * the trailing window from "now". This fixes the classic fixed-window bug
 * (a client can burst 2x the limit right at a window boundary) while costing
 * O(1) storage per key instead of the O(n) storage the log algorithm needs.
 * It's an approximation, not exact — worth knowing and saying out loud, not
 * hiding, if asked in an interview.
 */

const REDIS_KEY_PREFIX = "rl:swc:";

const SLIDING_WINDOW_COUNTER_SCRIPT = `
local current_key = KEYS[1]
local previous_key = KEYS[2]
local limit = tonumber(ARGV[1])
local window_ms = tonumber(ARGV[2])
local overlap_weight = tonumber(ARGV[3])

local current_count = tonumber(redis.call("GET", current_key) or "0")
local previous_count = tonumber(redis.call("GET", previous_key) or "0")

local estimated = (previous_count * overlap_weight) + current_count

local allowed = 0
if estimated < limit then
  current_count = redis.call("INCR", current_key)
  redis.call("PEXPIRE", current_key, window_ms * 2)
  allowed = 1
  estimated = estimated + 1
end

return {allowed, estimated}
`;

let scriptSha = null;

async function loadScript(redis) {
  if (!scriptSha) {
    scriptSha = await redis.script("LOAD", SLIDING_WINDOW_COUNTER_SCRIPT);
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
    throw new Error("slidingWindowCounter.consume requires limit and windowSeconds");
  }

  const windowMs = windowSeconds * 1000;
  const now = Date.now();
  const bucketIndex = Math.floor(now / windowMs);
  const elapsedInCurrentMs = now - bucketIndex * windowMs;
  const overlapWeight = (windowMs - elapsedInCurrentMs) / windowMs;

  const currentKey = `${REDIS_KEY_PREFIX}${identifier}:${bucketIndex}`;
  const previousKey = `${REDIS_KEY_PREFIX}${identifier}:${bucketIndex - 1}`;

  const sha = await loadScript(redis);
  let result;
  try {
    result = await redis.evalsha(sha, 2, currentKey, previousKey, limit, windowMs, overlapWeight);
  } catch (err) {
    if (err.message && err.message.includes("NOSCRIPT")) {
      scriptSha = null;
      const freshSha = await loadScript(redis);
      result = await redis.evalsha(freshSha, 2, currentKey, previousKey, limit, windowMs, overlapWeight);
    } else {
      throw err;
    }
  }

  const [allowed, estimatedCount] = result;
  return {
    allowed: allowed === 1,
    remaining: Math.max(0, Math.floor(limit - Number(estimatedCount))),
  };
}

module.exports = { consume };
