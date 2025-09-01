// electron/db/migrate-data.js
// One-off migration from SQLite (./data/app.db) to MySQL using env vars
// Env required: MYSQL_HOST, MYSQL_PORT (opt), MYSQL_USER, MYSQL_PASSWORD (opt), MYSQL_DATABASE

const fs = require('fs');
const path = require('path');
const mysql = require('mysql2/promise');
const BetterSqlite3 = require('better-sqlite3');

function env(name, fallback) {
  const v = process.env[name];
  if (v == null || v === '') {
    if (fallback !== undefined) return fallback;
    throw new Error(`Missing env ${name}`);
  }
  return v;
}

async function ensureDatabaseExists(pool, dbName) {
  await pool.query(`CREATE DATABASE IF NOT EXISTS \`${dbName}\` DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci`);
}

function splitSqlStatements(sql) {
  return sql.split(/;\s*\n/).map(s => s.trim()).filter(Boolean);
}

async function main() {
  const sqlitePath = process.env.SQLITE_PATH || path.join(process.cwd(), 'data', 'app.db');
  if (!fs.existsSync(sqlitePath)) {
    console.error('[migrate-data] SQLite DB not found at', sqlitePath);
    process.exit(1);
  }

  const host = env('MYSQL_HOST', 'localhost');
  const port = Number(env('MYSQL_PORT', '3306'));
  const user = env('MYSQL_USER');
  const password = env('MYSQL_PASSWORD', '');
  const database = env('MYSQL_DATABASE');

  const rootPool = await mysql.createPool({ host, port, user, password, waitForConnections: true, connectionLimit: 5 });
  try { await ensureDatabaseExists(rootPool, database); } finally { await rootPool.end(); }

  const pool = await mysql.createPool({ host, port, user, password, database, waitForConnections: true, connectionLimit: 10 });

  const schemaPath = fs.existsSync(path.join(__dirname, 'schema.mysql.sql'))
    ? path.join(__dirname, 'schema.mysql.sql')
    : path.join(process.cwd(), 'electron', 'db', 'schema.mysql.sql');
  const ddl = fs.readFileSync(schemaPath, 'utf8');
  for (const s of splitSqlStatements(ddl)) { await pool.query(s); }

  const sqlite = new BetterSqlite3(sqlitePath);

  const users = sqlite.prepare('SELECT id, username, password_hash, role, created_at FROM users').all();
  const items = sqlite.prepare('SELECT id, name, created_at FROM items').all();

  console.log(`[migrate-data] Migrating ${users.length} users, ${items.length} items...`);

  // Upsert users by username
  for (const u of users) {
    await pool.execute(
      'INSERT INTO users (username, password_hash, role, created_at) VALUES (?,?,?,?) ON DUPLICATE KEY UPDATE password_hash=VALUES(password_hash), role=VALUES(role)',
      [u.username, u.password_hash, u.role, u.created_at]
    );
  }

  // Insert items (no natural key; just insert new rows)
  for (const it of items) {
    await pool.execute(
      'INSERT INTO items (name, created_at) VALUES (?, ?)',
      [it.name, it.created_at]
    );
  }

  console.log('[migrate-data] Done.');
  await pool.end();
}

main().catch(err => { console.error(err); process.exit(1); });

