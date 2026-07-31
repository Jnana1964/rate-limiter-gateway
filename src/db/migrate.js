const fs = require("fs");
const path = require("path");
const mysql = require("mysql2/promise");
const config = require("../config");

async function migrate() {
  const schemaPath = path.join(__dirname, "..", "..", "sql", "schema.sql");
  const schema = fs.readFileSync(schemaPath, "utf8");

  // A dedicated one-off connection with multipleStatements enabled. This is
  // deliberately NOT the same pool the app uses at runtime (see mysql.js) --
  // multipleStatements is a real SQL-injection risk if left on for
  // request-handling queries, so it's scoped to this migration script only,
  // which reads a trusted local file rather than user input.
  const connection = await mysql.createConnection({
    host: config.db.host,
    port: config.db.port,
    user: config.db.user,
    password: config.db.password,
    database: config.db.database,
    multipleStatements: true,
  });

  try {
    await connection.query(schema);
    console.log("Migration applied successfully.");
  } finally {
    await connection.end();
  }
}

migrate().catch((err) => {
  console.error("Migration failed:", err.message);
  process.exit(1);
});