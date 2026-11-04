<div align="center">

<h1>🚦 Rate Limiter Gateway</h1>

<h3>Redis-Backed API Rate Limiting, Built for Correctness Under Concurrency</h3>

<p>Token Bucket → Sliding Window Log → Sliding Window Counter → Atomic Lua Scripts</p>

<p>
<img src="https://img.shields.io/badge/status-deployed-brightgreen" alt="status deployed">
<img src="https://img.shields.io/badge/Node.js-Express-339933?logo=nodedotjs&logoColor=white" alt="Node.js Express">
<img src="https://img.shields.io/badge/Redis-Lua_scripts-DC382D?logo=redis&logoColor=white" alt="Redis Lua scripts">
<img src="https://img.shields.io/badge/MySQL-API_keys-4479A1?logo=mysql&logoColor=white" alt="MySQL API keys">
<img src="https://img.shields.io/badge/Auth-JWT-000000?logo=jsonwebtokens&logoColor=white" alt="Auth JWT">
<img src="https://img.shields.io/badge/Docker-Compose-2496ED?logo=docker&logoColor=white" alt="Docker Compose">
<img src="https://img.shields.io/badge/tests-6%2F6_passing-brightgreen" alt="tests 6 of 6 passing">
</p>

<p><b>Limit smarter. Block fairly. Prove it under concurrency.</b></p>

<p>
<b>Live demo:</b> <a href="https://rate-limiter-gateway-tb6n.onrender.com/demo">rate-limiter-gateway-tb6n.onrender.com/demo</a>
·
<b>API:</b> <a href="https://rate-limiter-gateway-tb6n.onrender.com/">rate-limiter-gateway-tb6n.onrender.com</a>
</p>

<p>Hosted on Render's free tier, so the first request after a period of inactivity can take up to a minute while the server wakes up.</p>

</div>

---

A Redis-backed rate-limiting API gateway with three interchangeable algorithms (token
bucket, sliding window log, sliding window counter), MySQL-backed API key management,
and JWT-authenticated admin routes.

Built to explore a real infrastructure problem, not a CRUD app, with the specific
goal of demonstrating correctness under concurrency, not just a working demo.

## Live demo

Open the [live demo page](https://rate-limiter-gateway-tb6n.onrender.com/demo), pick an
algorithm, a limit and a window, click **Create demo key**, then click **Send 10 at once**.
Requests inside the limit return `200`; the rest return `429` with a `Retry-After` header.
The demo page talks to the same API described below.

<!-- Add your screenshot after uploading it to the repo as docs/demo.png -->
![Live demo: allowed (200) and blocked (429) requests](docs/demo.png)

## What this is, honestly

This is a rate limiter with Redis-backed shared state, currently running as a
**single gateway instance** talking to a **single Redis instance and a single MySQL
instance**. It is not, today, a distributed multi-node system, and this README won't
claim otherwise. What it *does* demonstrate is the piece that would let it become
distributed: the state that matters (the counters) lives in Redis, not in the
process's memory, so multiple instances of this same app *could* share it correctly.
That claim is proven in the concurrency tests below. Actually running multiple
instances behind a load balancer and proving the atomicity holds across them is a
real next step, not something already done. See "Honest scope notes."

## Why this exists

Every large-scale API needs to answer: *what happens when a client sends more
requests than they should?* Amazon's own API Gateway, DynamoDB, and Lambda all have
built-in throttling for exactly this reason: one misbehaving client shouldn't be
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
needs to survive a restart, so that is MySQL. The request counters don't need to
survive a restart, and need to be fast and shareable across multiple instances of
the app, so that is Redis. Losing Redis data just resets everyone's counters; losing
MySQL data loses the actual user/key records.

## The three algorithms

| Algorithm | How it works | Tradeoff |
|---|---|---|
| **Token bucket** | Bucket refills continuously at a fixed rate; each request consumes one token | Allows bursts up to bucket capacity; smooth average rate over time |
| **Sliding window log** | Stores a timestamp per request in a Redis sorted set, counts entries in the trailing window | Exactly accurate, no boundary bugs; costs more memory (one entry per request) |
| **Sliding window counter** | Approximates the sliding window using two fixed-window counters, weighted by overlap | Cheap (O(1) storage per key); an approximation, not exact, which is worth saying out loud, not hiding |

All three are implemented as **atomic Redis Lua scripts**, not read-then-write
JavaScript. Without that, two concurrent requests can both read the same
"under limit" state and both get allowed past the limit. That is a real race condition,
not a theoretical one. This is what `tests/limiters.test.js` actually checks: it
fires 50 concurrent requests at each algorithm and asserts the allowed count never
exceeds the configured limit, using real Redis, not a mock.

A real design decision, not an oversight: if Redis becomes unreachable, the
middleware **fails open** (`src/middleware/rateLimit.js`), so requests are allowed
through rather than the whole API going down. That's a deliberate
availability-over-strict-enforcement tradeoff. Fail-closed is equally defensible
depending on the use case; this codebase has not tested what actually happens
when Redis dies mid-load. See "Honest scope notes."

## Verified results — every number below was actually run, not projected

- **6/6 automated tests pass**, including two concurrency tests firing 50
  simultaneous requests per algorithm against real Redis and confirming no
  over-allowance.
- **All three algorithms independently verified end-to-end** against a live
  deployment: configured with a 10-request/60s limit, each correctly allowed
  exactly 10 requests and returned `429` on requests 11 through 15.
- **Load tested with k6**: 1,300 requests/second sustained over 2m30s
  (197,402 total requests), p95 latency of 107ms, zero crashes or malformed
  responses across the whole run.
  - Note on reading this number: k6's default `http_req_failed` metric flags any
    non-2xx response, which was ~99.98% in this run. That is *not* a system
    failure. The test key was capped at 10 requests/minute while the test fired
    over a thousand requests/second, so the overwhelming majority correctly
    received `429`. The metric that actually matters is `checks_succeeded: 100%`:
    every request got a valid, well-formed response, and the gateway never
    crashed or hung under sustained heavy load.
- **Deployed and verified live.** The end-to-end checks above (registration,
  login, JWT auth, key creation, and the 10-allowed/5-blocked pattern) were first
  run against a Railway deployment. The service now runs on Render, with its
  MySQL database on Aiven, and the live demo page exercises the same flow
  against it.

## Hosting

| Part | Where it runs |
|---|---|
| Gateway (Node.js / Express) | Render (free web service) |
| MySQL | Aiven (free plan) |
| Redis | Redis instance attached to the deployment |

Free tiers have limits: the Render service sleeps after about 15 minutes without
traffic (the first request afterwards can take up to a minute), and Aiven's free
MySQL can be powered off after a long period of inactivity.

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

Then open `http://localhost:5000/demo` for the demo page.

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

# hit the gateway repeatedly: the 11th call within a minute returns 429
curl http://localhost:5000/gateway/ping -H "x-api-key: <key>"
```

### Load testing

```bash
k6 run loadtest/k6-script.js -e BASE_URL=http://localhost:5000 -e API_KEY=<key>
```

## API reference

| Method | Path | Auth | Purpose |
|---|---|---|---|
| GET | `/` | none | Service info |
| GET | `/health` | none | Health check |
| GET | `/demo` | none | Interactive demo page |
| POST | `/admin/register` | none | Create an account |
| POST | `/admin/login` | none | Get a JWT |
| POST | `/admin/keys` | JWT | Create an API key (algorithm, limit, window) |
| GET | `/admin/keys` | JWT | List your keys |
| DELETE | `/admin/keys/:id` | JWT | Deactivate a key |
| GET | `/gateway/ping` | `x-api-key` | Rate-limited test endpoint |
| GET | `/gateway/data/:id` | `x-api-key` | Rate-limited endpoint with simulated latency |
| POST | `/gateway/echo` | `x-api-key` | Rate-limited echo endpoint |

Every gateway response includes `X-RateLimit-Limit` and `X-RateLimit-Remaining`.
A blocked request returns `429` with a `Retry-After` header.

## Project structure

```
public/
  demo.html               # interactive demo page served at /demo
src/
  config.js               # env var loading, fails fast if required vars missing
  server.js               # Express app entrypoint
  db/
    redis.js              # shared Redis connection
    mysql.js              # MySQL connection pool (runtime queries)
    migrate.js            # one-off connection with multipleStatements, applies schema.sql
  limiters/
    tokenBucket.js        # atomic Lua-script implementation
    slidingWindowLog.js   # atomic Lua-script implementation
    slidingWindowCounter.js # atomic Lua-script implementation
    index.js              # dispatches to the configured algorithm
  middleware/
    rateLimit.js          # looks up key config, checks limit, sets headers
    auth.js               # JWT verification for admin routes
  routes/
    admin.js              # register/login/create-key/list-keys
    gateway.js            # example endpoints protected by the rate limiter
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
  tests prove), but that has not been run: no load balancer, no second instance,
  no test proving correctness *across* instances rather than within one.
- **No chaos/failure testing done.** The fail-open behavior when Redis is
  unreachable is implemented and described above, but never actually exercised.
  Nobody has killed the Redis connection mid-load-test and watched what happens.
  That's a real gap between "the code does this" and "this was observed to work."
- **No CI/CD.** Tests are run manually, locally. There is no pipeline running them
  automatically on push, and deploys are triggered by hand.
- **No monitoring or metrics export.** No Prometheus, no CloudWatch, no dashboard
  showing request rate, error rate, or Redis latency over time in production.
  Problems would currently be found by manually checking logs, not by an alert.
- **No admin UI.** Key management is API-only. The demo page creates a throwaway
  account and key per visit; there is no cleanup job, and `/admin/register` has no
  rate limit of its own.
- **`Retry-After` is approximate for the token bucket.** It reports the full window
  length, while the next token actually becomes available sooner (for example, about
  2 seconds for a 5-requests-per-10-seconds bucket). Computing the exact time until
  the next token is a known improvement.
- **The sliding window counter is an approximation by design.** It will
  occasionally allow a request slightly over or under the exact configured limit
  near window boundaries. Expected behavior, not a bug.
- **The in-process API key config cache (10s TTL)** means a key edited in the
  database can take up to 10 seconds to reflect in enforcement. Acceptable for
  this scope; a production system would likely use Redis pub/sub to invalidate
  the cache immediately instead.
- **Free-tier hosting.** Cold starts after idle periods, and a free database that
  can be powered off when unused, are hosting limits, not properties of the code.

None of the above is disqualifying for what this project is: an infrastructure
piece built to demonstrate correctness under concurrency. It's disqualifying only
if the README pretended these gaps didn't exist.

## 👤 Author

<div align="center">

**Bollu Jnana Keerthana**
B.Tech Computer Science and Engineering · SRM Institute of Science and Technology

[GitHub](https://github.com/Jnana1964) · [Portfolio](https://jnana1964.github.io)

</div>
