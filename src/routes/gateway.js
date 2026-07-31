const express = require("express");
const rateLimitMiddleware = require("../middleware/rateLimit");

const router = express.Router();

// Everything under /gateway is protected by the rate limiter. These routes
// simulate what a real backend service would expose — the point isn't the
// business logic here, it's proving the limiter correctly gates traffic to
// whatever sits behind it.
router.use(rateLimitMiddleware);

router.get("/ping", (req, res) => {
  res.json({ message: "pong", timestamp: Date.now() });
});

router.get("/data/:id", (req, res) => {
  // Simulates a real downstream call with non-trivial latency, so load tests
  // produce realistic p99 numbers instead of near-zero response times.
  const simulatedLatencyMs = Math.floor(Math.random() * 40) + 10;
  setTimeout(() => {
    res.json({ id: req.params.id, retrievedAt: Date.now() });
  }, simulatedLatencyMs);
});

router.post("/echo", (req, res) => {
  res.json({ received: req.body, timestamp: Date.now() });
});

module.exports = router;
