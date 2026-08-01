const express = require("express");
const bcrypt = require("bcrypt");
const jwt = require("jsonwebtoken");
const crypto = require("crypto");

const pool = require("../db/mysql");
const config = require("../config");
const { requireAuth } = require("../middleware/auth");

const router = express.Router();

const BCRYPT_ROUNDS = 12;
const VALID_ALGORITHMS = ["token_bucket", "sliding_window_log", "sliding_window_counter"];

router.post("/register", async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) {
    return res.status(400).json({ error: "email and password are required" });
  }
  if (password.length < 8) {
    return res.status(400).json({ error: "password must be at least 8 characters" });
  }

  try {
    const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);
    const [result] = await pool.query(
      "INSERT INTO users (email, password_hash) VALUES (?, ?)",
      [email, passwordHash]
    );
    return res.status(201).json({ id: result.insertId, email });
  } catch (err) {
    if (err.code === "ER_DUP_ENTRY") {
      return res.status(409).json({ error: "email already registered" });
    }
    console.error("[admin/register] FULL ERROR");
console.error(err);
    return res.status(500).json({ error: "registration failed" });
  }
});

router.post("/login", async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) {
    return res.status(400).json({ error: "email and password are required" });
  }

  const [rows] = await pool.query(
    "SELECT id, password_hash FROM users WHERE email = ? LIMIT 1",
    [email]
  );
  if (rows.length === 0) {
    return res.status(401).json({ error: "invalid credentials" });
  }

  const user = rows[0];
  const matches = await bcrypt.compare(password, user.password_hash);
  if (!matches) {
    return res.status(401).json({ error: "invalid credentials" });
  }

  const token = jwt.sign({ userId: user.id }, config.jwt.secret, {
    expiresIn: config.jwt.expiresIn,
  });
  return res.json({ token });
});

// Creates a new API key with a real, caller-chosen rate limit config.
// No default "free" limit is silently applied — the caller must specify it,
// so there's no hidden static value here either.
router.post("/keys", requireAuth, async (req, res) => {
  const { algorithm, limit_per_window, window_seconds, burst_capacity } = req.body;

  if (!VALID_ALGORITHMS.includes(algorithm)) {
    return res.status(400).json({ error: `algorithm must be one of ${VALID_ALGORITHMS.join(", ")}` });
  }
  if (!Number.isInteger(limit_per_window) || limit_per_window <= 0) {
    return res.status(400).json({ error: "limit_per_window must be a positive integer" });
  }
  if (!Number.isInteger(window_seconds) || window_seconds <= 0) {
    return res.status(400).json({ error: "window_seconds must be a positive integer" });
  }

  const keyValue = crypto.randomBytes(24).toString("hex");

  await pool.query(
    `INSERT INTO api_keys (key_value, user_id, algorithm, limit_per_window, window_seconds, burst_capacity)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [keyValue, req.userId, algorithm, limit_per_window, window_seconds, burst_capacity || null]
  );

  return res.status(201).json({
    key: keyValue,
    algorithm,
    limit_per_window,
    window_seconds,
    burst_capacity: burst_capacity || limit_per_window,
  });
});

router.get("/keys", requireAuth, async (req, res) => {
  const [rows] = await pool.query(
    `SELECT id, key_value, algorithm, limit_per_window, window_seconds, burst_capacity, is_active, created_at
     FROM api_keys WHERE user_id = ?`,
    [req.userId]
  );
  return res.json(rows);
});

router.delete("/keys/:id", requireAuth, async (req, res) => {
  const [result] = await pool.query(
    "UPDATE api_keys SET is_active = FALSE WHERE id = ? AND user_id = ?",
    [req.params.id, req.userId]
  );
  if (result.affectedRows === 0) {
    return res.status(404).json({ error: "key not found" });
  }
  return res.status(204).send();
});

module.exports = router;
