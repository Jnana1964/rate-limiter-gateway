Here's the full content — copy everything below into a new `README.md` file in your project root.

```markdown
# Rate Limiter Gateway

A distributed, Redis-backed rate-limiting API gateway with three interchangeable
algorithms (token bucket, sliding window log, sliding window counter), MySQL-backed
API key management, and JWT-authenticated admin routes.

Built to explore a real infrastructure problem — not a CRUD app — with the specific
goal of demonstrating correctness under concurrency, not just a working demo.

## Why this exists

Every large-scale API needs to answer: *what happens when a client sends more
requests than they should?* Amazon's own API Gateway, DynamoDB, and Lambda all have
built-in throttling for exactly this reason — one misbehaving client shouldn't be
able to degrade service for everyone else, and usage tiers need real enforcement.

This project implements that piece from scratch: three real algorithms, atomic
Redis operations to make them safe across multiple server instances, and a small
gateway to prove it actually gates traffic to something behind it.

## Architecture

```
Client
  │  x-api-key header
  ▼
Express middleware (rateLimit.js)
  │
  ├─► MySQL  — durable API key config (algorithm, limit, window)
  │            cached in-process for 10s to avoid a DB hit per request
  │
  └─► Redis  — ephemeral rate-limit counters, checked via atomic Lua scripts
               (token bucket / sliding window log / sliding window counter)
  │
  ▼
200 response, or 429 if over limit
```

**Why split MySQL and Redis this way:** API key configuration (who has what limit)
needs to survive a restart — that's MySQL. The actual request counters don't need
to survive a restart, and need to be fast and shared across every instance of the
app — that's Redis. Losing Redis data just resets everyone's counters; losing MySQL
data loses your users.

## The three algorithms

| Algorithm | How it works | Tradeoff |
|---|---|---|
| **Token bucket** | Bucket refills continuously at a fixed rate; each request consumes one token | Allows bursts up to bucket capacity; smooth average rate over time |
| **Sliding window log** | Stores a timestamp per request in a Redis sorted set, counts entries in the trailing window | Exactly accurate, no boundary bugs; costs more memory (one entry per request) |
| **Sliding window counter** | Approximates the sliding window using two fixed-window counters, weighted by overlap | Cheap (O(1) storage per key); an approximation, not exact — worth saying out loud, not hiding |

All three are implemented as **atomic Redis Lua scripts**, not
read-then-write JavaScript. Without that, two concurrent requests can both read the
same "under limit" state and both get allowed past the limit — a real race
condition, not a theoretical one. This is validated directly in `tests/limiters.test.js`,
which fires 50 concurrent requests at each algorithm and asserts the allowed count
never exceeds the configured limit.

A real design decision worth knowing, not an oversight: if Redis becomes
unreachable, the middleware **fails open** (`src/middleware/rateLimit.js`) —
requests are allowed through rather than the whole API going down. That's a
deliberate availability-over-strict-enforcement tradeoff; the opposite choice
(fail-closed) is equally defensible depending on the use case, and worth discussing
either way.

## Verified results (not projected — actually run)

- **6/6 automated tests pass**, including two concurrency tests firing 50
  simultaneous requests per algorithm and confirming no over-allowance.
- **All three algorithms independently verified end-to-end**: configured with a
  10-request/60s limit, each correctly allowed exactly 10 requests and returned
  `429` on requests 11 through 15.
- **Load tested with k6**: ~1,300 requests/second sustained over 2.5 minutes
  (197,402 total requests), p95 latency of 107ms, zero crashes or malformed
  responses. The overwhelming majority of requests correctly received `429`
  once traffic exceeded the configured 10/min key limit — that's the rate
  limiter working as intended, not a system failure.

## Running it locally

**Prerequisites:** Node.js 18+, Docker Desktop.

```bash
cp .env.example .env
# fill in DB_USER, DB_PASSWORD, DB_NAME, and a generated JWT_SECRET:
#   node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"

docker compose up -d      # starts Redis + MySQL
npm install
npm run migrate           # applies sql/schema.sql
npm test                  # run the concurrency-safety test suite
npm start                 # starts the API on the configured PORT
```

### Try it end-to-end

```bash
# register
curl -X POST http://localhost:5000/admin/register \
  -H "Content-Type: application/json" \
  -d '{"email":"you@example.com","password":"testpass123"}'

# login
curl -X POST http://localhost:5000/admin/login \
  -H "Content-Type: application/json" \
  -d '{"email":"you@example.com","password":"testpass123"}'
# -> copy the token

# create a key
curl -X POST http://localhost:5000/admin/keys \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <token>" \
  -d '{"algorithm":"token_bucket","limit_per_window":10,"window_seconds":60}'
# -> copy the key

# hit the gateway repeatedly — the 11th call within a minute returns 429
curl http://localhost:5000/gateway/ping -H "x-api-key: <key>"
```

### Load testing

```bash
k6 run loadtest/k6-script.js -e BASE_URL=http://localhost:5000 -e API_KEY=<key>
```

## Project structure

```
src/
  config.js              # env var loading, fails fast if required vars missing
  server.js              # Express app entrypoint
  db/
    redis.js               # shared Redis connection
    mysql.js                # MySQL connection pool (runtime queries)
    migrate.js             # one-off connection with multipleStatements, applies schema.sql
  limiters/
    tokenBucket.js          # atomic Lua-script implementation
    slidingWindowLog.js     # atomic Lua-script implementation
    slidingWindowCounter.js # atomic Lua-script implementation
    index.js                # dispatches to the configured algorithm
  middleware/
    rateLimit.js            # looks up key config, checks limit, sets headers
    auth.js                 # JWT verification for admin routes
  routes/
    admin.js                # register/login/create-key/list-keys
    gateway.js               # example endpoints protected by the rate limiter
tests/
  limiters.test.js         # integration tests against real Redis, incl. concurrency checks
loadtest/
  k6-script.js             # ramping load test script
sql/
  schema.sql               # users + api_keys tables
```

## Honest scope notes

- This is an intern-level infrastructure project, not a production system. It has
  no horizontal-scaling test beyond a single app instance, no observability/metrics
  export, and no admin UI.
- The sliding window counter is an approximation by design — it will occasionally
  allow a request slightly over or under the exact configured limit near window
  boundaries. That's expected behavior, not a bug.
- The in-process API key config cache (10s TTL) means a key edited in the database
  can take up to 10 seconds to reflect in enforcement. Acceptable for this scope;
  a production system would likely use Redis pub/sub to invalidate the cache
  immediately instead.
```

Save that as `README.md` in your project root, then:
```powershell
git add README.md
git commit -m "Add README with architecture, verified results, and setup instructions"
git push
```