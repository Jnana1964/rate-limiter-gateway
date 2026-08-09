# Rate Limiter Gateway

A Redis-backed rate-limiting API gateway with three interchangeable algorithms (token
bucket, sliding window log, sliding window counter), MySQL-backed API key management,
and JWT-authenticated admin routes.

Built to explore a real infrastructure problem — not a CRUD app — with the specific
goal of demonstrating correctness under concurrency, not just a working demo.

**Live:** https://rate-limiter-gateway-production.up.railway.app/health
**Source:** this repository

## What this is, honestly

This is a rate limiter with Redis-backed shared state — currently running as a
**single gateway instance** talking to a **single Redis instance and a single MySQL
instance**. It is not, today, a distributed multi-node system, and this README won't
claim otherwise. What it *does* demonstrate is the piece that would let it become
distributed: the state that matters (the counters) lives in Redis, not in the
process's memory, so multiple instances of this same app *could* share it correctly.
That claim is proven in the concurrency tests below. Actually running multiple
instances behind a load balancer and proving the atomicity holds across them is a
real next step, not something already done — see "Honest scope notes."

## Why this exists

Every large-scale API needs to answer: *what happens when a client sends more
requests than they should?* Amazon's own API Gateway, DynamoDB, and Lambda all have
built-in throttling for exactly this reason — one misbehaving client shouldn't be
able to degrade service for everyone else, and usage tiers need real enforcement.

This project implements that piece from scratch: three real algorithms, atomic
Redis operations to make the concurrency-safety claim actually true, and a small
gateway to prove it gates real traffic.

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
  └─► Redis  — rate-limit counters, checked via atomic Lua scripts
               (token bucket / sliding window log / sliding window counter)
  │
  ▼
200 response, or 429 if over limit
```

**Why split MySQL and Redis this way:** API key configuration (who has what limit)
needs to survive a restart — that's MySQL. The request counters don't need to
survive a restart, and need to be fast and shareable across multiple instances of
the app — that's Redis. Losing Redis data just resets everyone's counters; losing
MySQL data loses the actual user/key records.

## The three algorithms

| Algorithm | How it works | Tradeoff |
|---|---|---|
| **Token bucket** | Bucket refills continuously at a fixed rate; each request consumes one token | Allows bursts up to bucket capacity; smooth average rate over time |
| **Sliding window log** | Stores a timestamp per request in a Redis sorted set, counts entries in the trailing window | Exactly accurate, no boundary bugs; costs more memory (one entry per request) |
| **Sliding window counter** | Approximates the sliding window using two fixed-window counters, weighted by overlap | Cheap (O(1) storage per key); an approximation, not exact — worth saying out loud, not hiding |

All three are implemented as **atomic Redis Lua scripts**, not read-then-write
JavaScript. Without that, two concurrent requests can both read the same
"under limit" state and both get allowed past the limit — a real race condition,
not a theoretical one. This is what `tests/limiters.test.js` actually checks: it
fires 50 concurrent requests at each algorithm and asserts the allowed count never
exceeds the configured limit, using real Redis, not a mock.

A real design decision, not an oversight: if Redis becomes unreachable, the
middleware **fails open** (`src/middleware/rateLimit.js`) — requests are allowed
through rather than the whole API going down. That's a deliberate
availability-over-strict-enforcement tradeoff. Fail-closed is equally defensible
depending on the use case; this codebase has not tested what actually happens
when Redis dies mid-load — see "Honest scope notes."

## Verified results — every number below was actually run, not projected

- **6/6 automated tests pass**, including two concurrency tests firing 50
  simultaneous requests per algorithm against real Redis and confirming no
  over-allowance.
- **All three algorithms independently verified end-to-end** against the live
  deployment: configured with a 10-request/60s limit, each correctly allowed
  exactly 10 requests and returned `429` on requests 11 through 15.
- **Load tested with k6**: 1,300 requests/second sustained over 2m30s
  (197,402 total requests), p95 latency of 107ms, zero crashes or malformed
  responses across the whole run.
  - Note on reading this number: k6's default `http_req_failed` metric flags any
    non-2xx response, which was ~99.98% in this run — that is *not* a system
    failure. The test key was capped at 10 requests/minute while the test fired
    over a thousand requests/second, so the overwhelming majority correctly
    received `429`. The metric that actually matters is `checks_succeeded: 100%`
    — every request got a valid, well-formed response, and the gateway never
    crashed or hung under sustained heavy load.
- **Deployed and re-verified live** on Railway (not just locally): registration,
  login, JWT auth, key creation, and the same 10-allowed/5-blocked pattern all
  confirmed against the production URL above.

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
    redis.js              # shared Redis connection
    mysql.js               # MySQL connection pool (runtime queries)
    migrate.js            # one-off connection with multipleStatements, applies schema.sql
  limiters/
    tokenBucket.js         # atomic Lua-script implementation
    slidingWindowLog.js    # atomic Lua-script implementation
    slidingWindowCounter.js # atomic Lua-script implementation
    index.js               # dispatches to the configured algorithm
  middleware/
    rateLimit.js           # looks up key config, checks limit, sets headers
    auth.js                # JWT verification for admin routes
  routes/
    admin.js               # register/login/create-key/list-keys
    gateway.js              # example endpoints protected by the rate limiter
tests/
  limiters.test.js        # integration tests against real Redis, incl. concurrency checks
loadtest/
  k6-script.js            # ramping load test script
sql/
  schema.sql              # users + api_keys tables
```

## Honest scope notes — what this project does not do yet

- **Not actually distributed.** One gateway process, one Redis instance, one MySQL
  instance. The design would support multiple gateway instances sharing the same
  Redis state correctly (that's what the atomic Lua scripts and the concurrency
  tests prove), but that has not been run — no load balancer, no second instance,
  no test proving correctness *across* instances rather than within one.
- **No chaos/failure testing done.** The fail-open behavior when Redis is
  unreachable is implemented and described above, but never actually exercised —
  nobody has killed the Redis connection mid-load-test and watched what happens.
  That's a real gap between "the code does this" and "this was observed to work."
- **No CI/CD.** Tests are run manually, locally. There is no pipeline running them
  automatically on push, no automated build/deploy.
- **No monitoring or metrics export.** No Prometheus, no CloudWatch, no dashboard
  showing request rate, error rate, or Redis latency over time in production.
  Problems would currently be found by manually checking logs, not by an alert.
- **No admin UI.** Key management is API-only.
- **The sliding window counter is an approximation by design** — it will
  occasionally allow a request slightly over or under the exact configured limit
  near window boundaries. Expected behavior, not a bug.
- **The in-process API key config cache (10s TTL)** means a key edited in the
  database can take up to 10 seconds to reflect in enforcement. Acceptable for
  this scope; a production system would likely use Redis pub/sub to invalidate
  the cache immediately instead.

None of the above is disqualifying for what this project is — an infrastructure
piece built to demonstrate correctness under concurrency. It's disqualifying only
if the README pretended these gaps didn't exist.

## 👤 Author

<div align="center">

**Bollu Jnana Keerthana**
Computer Science Engineering · SRM University

[GitHub](https://github.com/Jnana1964) · [LinkedIn](https://www.linkedin.com/in/jnana-keerthana-1906jk)

</div>
