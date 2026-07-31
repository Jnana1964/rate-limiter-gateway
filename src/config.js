require("dotenv").config();

function required(name, fallback) {
  const value = process.env[name] || (fallback ? process.env[fallback] : undefined);

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

  redisUrl:
    process.env.REDIS_URL ||
    process.env.REDIS_PUBLIC_URL ||
    `redis://${
      process.env.REDISHOST || "localhost"
    }:${
      process.env.REDISPORT || "6379"
    }`,

  db: {
    host:
      process.env.DB_HOST ||
      process.env.MYSQLHOST ||
      "localhost",

    port: parseInt(
      process.env.DB_PORT ||
      process.env.MYSQLPORT ||
      "3306",
      10
    ),

    user: required("DB_USER", "MYSQLUSER"),

    password:
      process.env.DB_PASSWORD ||
      process.env.MYSQLPASSWORD ||
      "",

    database: required("DB_NAME", "MYSQLDATABASE"),
  },

  jwt: {
    secret: required("JWT_SECRET"),
    expiresIn: process.env.JWT_EXPIRES_IN || "1h",
  },
};

module.exports = config;