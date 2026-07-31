const Redis = require("ioredis");
const config = require("../config");

const redis = new Redis(config.redisUrl, {
  maxRetriesPerRequest: 3,
  retryStrategy(times) {
    // exponential backoff, capped at 3s
    return Math.min(times * 200, 3000);
  },
});

redis.on("error", (err) => {
  console.error("[redis] connection error:", err.message);
});

redis.on("connect", () => {
  console.log("[redis] connected");
});

module.exports = redis;
