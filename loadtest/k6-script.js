/**
 * Load test for the rate-limited gateway. Run with:
 *   k6 run loadtest/k6-script.js -e BASE_URL=http://localhost:3000 -e API_KEY=<real key>
 *
 * You must create a real API key first via POST /admin/keys (see README) and
 * pass it in — this script does not embed a working key.
 *
 * What this actually measures:
 *   - Throughput the gateway can sustain (req/sec)
 *   - Latency distribution under concurrent load (p50/p95/p99)
 *   - Whether the rate limiter's 429 rate matches what you configured
 *     (e.g. if you set limit=100/min and send 300/min, ~66% should be 429s)
 *
 * These numbers are what you report on your resume — run this yourself and
 * record the actual output. Don't guess or round up.
 */

import http from "k6/http";
import { check } from "k6";

const BASE_URL = __ENV.BASE_URL || "http://localhost:3000";
const API_KEY = __ENV.API_KEY;

if (!API_KEY) {
  throw new Error("Set -e API_KEY=<key> to a real key created via POST /admin/keys");
}

export const options = {
  scenarios: {
    ramping_load: {
      executor: "ramping-vus",
      startVUs: 0,
      stages: [
        { duration: "30s", target: 20 },   // ramp up to 20 concurrent virtual users
        { duration: "1m", target: 50 },    // hold at 50 concurrent
        { duration: "30s", target: 100 },  // spike to 100 to see where it breaks
        { duration: "30s", target: 0 },    // ramp down
      ],
    },
  },
  thresholds: {
    // These are goals to test against, not guaranteed outcomes — report
    // whatever the real run produces, including if it fails these.
    http_req_duration: ["p(95)<500"],
  },
};

export default function () {
  const res = http.get(`${BASE_URL}/gateway/ping`, {
    headers: { "x-api-key": API_KEY },
  });

  check(res, {
    "status is 200 or 429": (r) => r.status === 200 || r.status === 429,
  });
}
