require("dotenv").config();

function required(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      `Missing required environment variable: ${name}. ` +
      `Copy .env.example to .env and fill it in.`
    );
  }
  return value;
}

const config = {
  port: parseInt(process.env.PORT || "3000", 10),

  redisUrl: process.env.REDIS_URL || "redis://localhost:6379",

  db: {
    host: process.env.DB_HOST || "localhost",
    port: parseInt(process.env.DB_PORT || "3306", 10),
    user: required("DB_USER"),
    password: process.env.DB_PASSWORD || "",
    database: required("DB_NAME"),
  },

  jwt: {
    secret: required("JWT_SECRET"),
    expiresIn: process.env.JWT_EXPIRES_IN || "1h",
  },
};

module.exports = config;
