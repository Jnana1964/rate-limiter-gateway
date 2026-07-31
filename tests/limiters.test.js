/**
 * These are integration tests, not unit tests with mocks. Mocking Redis
 * would defeat the entire point — the thing under test IS the atomicity of
 * the Redis Lua scripts under concurrent access, which a mock can't
 * reproduce. Run `docker compose up -d redis` before running these.
 *
 * Run with: node --test tests/
 */

const test = require("node:test");
const assert = require("node:assert");
const Redis = require("ioredis");

const tokenBucket = require("../src/limiters/tokenBucket");
const slidingWindowLog = require("../src/limiters/slidingWindowLog");
const slidingWindowCounter = require("../src/limiters/slidingWindowCounter");

const redis = new Redis(process.env.REDIS_URL || "redis://localhost:6379");

function randomIdentifier(prefix) {
  return `${prefix}-${Math.random().toString(36).slice(2, 10)}`;
}

test("tokenBucket: allows exactly `capacity` requests immediately, then denies", async () => {
  const id = randomIdentifier("tb");
  const capacity = 5;
  const refillRatePerSec = 1; // slow refill so it won't interfere mid-test

  let allowedCount = 0;
  for (let i = 0; i < capacity + 3; i++) {
    const result = await tokenBucket.consume(redis, id, { capacity, refillRatePerSec });
    if (result.allowed) allowedCount++;
  }

  assert.strictEqual(allowedCount, capacity);
});

test("tokenBucket: refills over time and allows more requests after waiting", async () => {
  const id = randomIdentifier("tb-refill");
  const capacity = 2;
  const refillRatePerSec = 10; // fast refill for a fast test

  await tokenBucket.consume(redis, id, { capacity, refillRatePerSec });
  await tokenBucket.consume(redis, id, { capacity, refillRatePerSec });
  const denied = await tokenBucket.consume(redis, id, { capacity, refillRatePerSec });
  assert.strictEqual(denied.allowed, false);

  await new Promise((resolve) => setTimeout(resolve, 200)); // ~2 tokens refill at rate 10/s

  const afterWait = await tokenBucket.consume(redis, id, { capacity, refillRatePerSec });
  assert.strictEqual(afterWait.allowed, true);
});

test("tokenBucket: concurrent requests never exceed capacity (race condition check)", async () => {
  const id = randomIdentifier("tb-race");
  const capacity = 10;
  const refillRatePerSec = 0.001; // effectively no refill during this test

  const concurrentRequests = 50;
  const results = await Promise.all(
    Array.from({ length: concurrentRequests }, () =>
      tokenBucket.consume(redis, id, { capacity, refillRatePerSec })
    )
  );

  const allowedCount = results.filter((r) => r.allowed).length;
  assert.strictEqual(allowedCount, capacity, "concurrent access must not allow more than capacity");
});

test("slidingWindowLog: allows exactly `limit` requests within the window", async () => {
  const id = randomIdentifier("swl");
  const limit = 4;
  const windowSeconds = 5;

  let allowedCount = 0;
  for (let i = 0; i < limit + 3; i++) {
    const result = await slidingWindowLog.consume(redis, id, { limit, windowSeconds });
    if (result.allowed) allowedCount++;
  }

  assert.strictEqual(allowedCount, limit);
});

test("slidingWindowLog: concurrent requests never exceed limit (race condition check)", async () => {
  const id = randomIdentifier("swl-race");
  const limit = 15;
  const windowSeconds = 5;

  const concurrentRequests = 50;
  const results = await Promise.all(
    Array.from({ length: concurrentRequests }, () =>
      slidingWindowLog.consume(redis, id, { limit, windowSeconds })
    )
  );

  const allowedCount = results.filter((r) => r.allowed).length;
  assert.strictEqual(allowedCount, limit, "concurrent access must not allow more than limit");
});

test("slidingWindowCounter: denies once estimated count exceeds limit", async () => {
  const id = randomIdentifier("swc");
  const limit = 6;
  const windowSeconds = 5;

  let allowedCount = 0;
  for (let i = 0; i < limit + 4; i++) {
    const result = await slidingWindowCounter.consume(redis, id, { limit, windowSeconds });
    if (result.allowed) allowedCount++;
  }

  // This is an approximation algorithm, so we assert it's close to the
  // limit, not exactly equal — asserting exact equality here would be
  // testing for behavior the algorithm doesn't promise.
  assert.ok(allowedCount <= limit, `allowed ${allowedCount} which exceeds limit ${limit}`);
  assert.ok(allowedCount >= limit - 1, `allowed only ${allowedCount}, algorithm may be over-restricting`);
});

test.after(async () => {
  await redis.quit();
});
