const tokenBucket = require("./tokenBucket");
const slidingWindowLog = require("./slidingWindowLog");
const slidingWindowCounter = require("./slidingWindowCounter");

/**
 * Runs the configured algorithm for one API key config.
 *
 * @param redis ioredis client
 * @param identifier the API key value (used as the Redis key namespace)
 * @param keyConfig row from api_keys table: { algorithm, limit_per_window, window_seconds, burst_capacity }
 */
async function checkLimit(redis, identifier, keyConfig) {
  const { algorithm, limit_per_window, window_seconds, burst_capacity } = keyConfig;

  switch (algorithm) {
    case "token_bucket": {
      const capacity = burst_capacity || limit_per_window;
      const refillRatePerSec = limit_per_window / window_seconds;
      return tokenBucket.consume(redis, identifier, { capacity, refillRatePerSec });
    }
    case "sliding_window_log":
      return slidingWindowLog.consume(redis, identifier, {
        limit: limit_per_window,
        windowSeconds: window_seconds,
      });
    case "sliding_window_counter":
      return slidingWindowCounter.consume(redis, identifier, {
        limit: limit_per_window,
        windowSeconds: window_seconds,
      });
    default:
      throw new Error(`Unknown rate limit algorithm: ${algorithm}`);
  }
}

module.exports = { checkLimit };
