const express = require("express");
const config = require("./config");
const adminRoutes = require("./routes/admin");
const gatewayRoutes = require("./routes/gateway");

const app = express();
app.use(express.json());

app.get("/health", (req, res) => {
  res.json({ status: "ok", timestamp: Date.now() });
});

app.use("/admin", adminRoutes);
app.use("/gateway", gatewayRoutes);

// Centralized error handler - anything that throws synchronously or calls
// next(err) lands here instead of crashing the process or leaking a stack
// trace to the client.
app.use((err, req, res, next) => {
  console.error("[unhandled]", err);
  res.status(500).json({ error: "internal server error" });
});

app.listen(config.port, () => {
  console.log(`rate-limiter-gateway listening on port ${config.port}`);
});
app.get("/", (req, res) => {
  res.json({
    project: "Rate Limiter Gateway",
    status: "Running",
    version: "1.0.0",
    health: "/health"
  });
});