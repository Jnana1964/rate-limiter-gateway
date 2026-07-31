const pool = require("../db/mysql");
const redis = require("../db/redis");
const { checkLimit } = require("../limiters");

// In-process cache of API key configs so we don't hit MySQL on every request.
// Rate-limit correctness lives entirely in Redis; this cache only avoids a
// DB round trip for the mostly-static config (algorithm, limit, window).
// TTL is intentionally short so a key edited in the DB (e.g. downgraded)
// takes effect within seconds, not indefinitely.
const CONFIG_CACHE_TTL_MS = 10_000;
const configCache = new Map(); // key_value -> { config, expiresAt }

async function getKeyConfig(keyValue) {
  const cached = configCache.get(keyValue);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.config;
  }

  const [rows] = await pool.query(
    `SELECT id, user_id, algorithm, limit_per_window, window_seconds, burst_capacity, is_active
     FROM api_keys WHERE key_value = ? LIMIT 1`,
    [keyValue]
  );

  const config = rows.length > 0 ? rows[0] : null;
  configCache.set(keyValue, { config, expiresAt: Date.now() + CONFIG_CACHE_TTL_MS });
  return config;
}

async function rateLimitMiddleware(req, res, next) {
  const apiKey = req.header("x-api-key");

  if (!apiKey) {
    return res.status(401).json({ error: "Missing X-API-Key header" });
  }

  let keyConfig;
  try {
    keyConfig = await getKeyConfig(apiKey);
  } catch (err) {
    console.error("[rateLimit] failed to load key config:", err.message);
    return res.status(503).json({ error: "Rate limiter temporarily unavailable" });
  }

  if (!keyConfig || !keyConfig.is_active) {
    return res.status(403).json({ error: "Invalid or inactive API key" });
  }

  let result;
  try {
    result = await checkLimit(redis, apiKey, keyConfig);
  } catch (err) {
    console.error("[rateLimit] Redis check failed:", err.message);
    // Fail-open vs fail-closed is a real design decision, not an oversight:
    // fail-open here so a Redis outage degrades to "no rate limiting"
    // instead of taking down the entire API. Document this choice explicitly
    // if asked — the alternative (fail-closed) is defensible too, depending
    // on whether availability or protection matters more for the use case.
    return next();
  }

  res.setHeader("X-RateLimit-Limit", keyConfig.limit_per_window);
  res.setHeader("X-RateLimit-Remaining", Math.max(0, result.remaining));

  if (!result.allowed) {
    res.setHeader("Retry-After", keyConfig.window_seconds);
    return res.status(429).json({ error: "Rate limit exceeded" });
  }

  next();
}

module.exports = rateLimitMiddleware;
