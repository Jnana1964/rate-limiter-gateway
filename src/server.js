const express = require("express");
const config = require("./config");
const path = require("path");

const adminRoutes = require("./routes/admin");
const gatewayRoutes = require("./routes/gateway");

const app = express();

// Middleware
app.use(express.json());

// Live demo page
app.get("/demo", (req, res) => {
  res.sendFile(path.join(__dirname, "..", "public", "demo.html"));
});

// ==========================
// Root Route
// ==========================
app.get("/", (req, res) => {
  res.status(200).json({
    project: "Rate Limiter Gateway",
    status: "Running",
    version: "1.0.0",
    message: "Welcome to the Rate Limiter Gateway API",
    endpoints: {
      health: "/health",
      gateway: "/gateway",
      admin: "/admin"
    }
  });
});

// ==========================
// Health Check
// ==========================
app.get("/health", (req, res) => {
  res.status(200).json({
    status: "ok",
    timestamp: new Date().toISOString()
  });
});

// ==========================
// Routes
// ==========================
app.use("/admin", adminRoutes);
app.use("/gateway", gatewayRoutes);

// ==========================
// Global Error Handler
// ==========================
app.use((err, req, res, next) => {
  console.error("[ERROR]", err);

  res.status(err.status || 500).json({
    success: false,
    message: err.message || "Internal Server Error"
  });
});

// ==========================
// Start Server
// ==========================
app.listen(config.port, "0.0.0.0", () => {
  console.log(`🚀 Rate Limiter Gateway running on port ${config.port}`);
});
