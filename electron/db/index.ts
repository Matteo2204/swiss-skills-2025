// electron/db/index.ts (MySQL adapter)
import fs from 'fs';
import path from 'path';
import type { Pool, PoolOptions, ResultSetHeader } from 'mysql2/promise';
import mysql from 'mysql2/promise';
import { hashPassword } from './utils';

type Row = Record<string, any>;

// Minimal DB wrapper to keep existing call sites unchanged
type Prepared = {
  get: (...args: any[]) => Promise<Row | undefined>;
  all: (...args: any[]) => Promise<Row[]>;
  run: (...args: any[]) => Promise<{ lastInsertRowid?: number; changes?: number }>;
};

type DBClass = {
  prepare: (sql: string) => Prepared;
  exec: (sql: string) => Promise<void>;
};

let pool: Pool | null = null;
let db: DBClass | null = null;

function log(...args: unknown[]) { console.log('[db]', ...args); }

function env(name: string, fallback?: string): string {
  const v = process.env[name];
  if (v == null || v === '') {
    if (fallback !== undefined) return fallback;
    throw new Error(`Missing env ${name}`);
  }
  return v;
}

function resolveMysqlSchemaPath(): string {
  const here = __dirname;
  const cwd = process.cwd();
  const candidates = [
    path.join(here, 'schema.mysql.sql'),
    path.join(cwd, 'electron', 'db', 'schema.mysql.sql'),
  ];
  for (const p of candidates) if (fs.existsSync(p)) return p;
  throw new Error('schema.mysql.sql not found in expected locations');
}

async function ensureDatabaseExists(rootPool: Pool, dbName: string) {
  await rootPool.query(`CREATE DATABASE IF NOT EXISTS \`${dbName}\` DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci`);
}

function splitSqlStatements(sql: string): string[] {
  // naive splitter safe enough for our simple schema files
  return sql
    .split(/;\s*\n/)
    .map(s => s.trim())
    .filter(Boolean);
}

function buildWrapper(p: Pool): DBClass {
  return {
    prepare(sql: string): Prepared {
      return {
        async get(...args: any[]) {
          const [rows]: any = await p.execute(sql, args);
          return Array.isArray(rows) ? (rows[0] as Row | undefined) : undefined;
        },
        async all(...args: any[]) {
          const [rows]: any = await p.execute(sql, args);
          return Array.isArray(rows) ? (rows as Row[]) : [];
        },
        async run(...args: any[]) {
          const [res] = await p.execute<ResultSetHeader>(sql, args);
          return {
            lastInsertRowid: (res as ResultSetHeader).insertId ?? undefined,
            changes: (res as ResultSetHeader).affectedRows ?? undefined,
          };
        },
      };
    },
    async exec(sql: string) {
      const stmts = splitSqlStatements(sql);
      for (const s of stmts) {
        if (!s) continue;
        try {
          await p.query(s);
        } catch (e: any) {
          const code = e?.code ?? e?.errno;
          // Ignore "duplicate index" if schema applied multiple times
          // or duplicate column when applying ALTERs
          if (code === 'ER_DUP_KEYNAME' || code === 1061 || code === 'ER_DUP_FIELDNAME' || code === 1060) continue;
          throw e;
        }
      }
    },
  };
}

export function getDB(): DBClass {
  if (!db) throw new Error('DB not initialized. Call initDB() first.');
  return db;
}

export async function initDB() {
  // External MySQL only: env vars if provided, else VM/dev defaults
  const host = env('MYSQL_HOST', 'localhost');
  const port = Number(env('MYSQL_PORT', '3306'));
  const user = env('MYSQL_USER', 'root');
  const password = env('MYSQL_PASSWORD', 'ictskills');
  const database = env('MYSQL_DATABASE', 'ictskills');

  const baseOpts: PoolOptions = {
    host, port, user, password,
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0,
    multipleStatements: false,
  };

  // Ensure database exists (best effort)
  try {
    const rootPool = await mysql.createPool(baseOpts);
    try { await ensureDatabaseExists(rootPool, database); } finally { await rootPool.end(); }
  } catch {}

  pool = await mysql.createPool({ ...baseOpts, database });
  db = buildWrapper(pool);

  // Apply schema
  const schemaPath = resolveMysqlSchemaPath();
  log('using schema:', schemaPath);
  const ddl = fs.readFileSync(schemaPath, 'utf8');
  await db.exec(ddl);

  // Migrate: ensure 'remember' column exists in sessions for older DBs
  try {
    const [rows]: any = await pool.query(
      `SELECT 1 FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'sessions' AND COLUMN_NAME = 'remember'`,
      [database]
    );
    const exists = Array.isArray(rows) && rows.length > 0;
    if (!exists) {
      await pool.query(`ALTER TABLE sessions ADD COLUMN remember TINYINT(1) NOT NULL DEFAULT 0`);
      log("migrated: added sessions.remember");
    }
  } catch (e) {
    log('migration check failed (non-fatal):', (e as Error)?.message);
  }

  // Minimal seed: ensure at least admin/operator users exist
  const row = (await db.prepare('SELECT COUNT(*) c FROM users').get()) as { c: number } | undefined;
  const count = row ? Number((row as any).c ?? (row as any)['COUNT(*)'] ?? 0) : 0;
  if (count === 0) {
    const ins = db.prepare('INSERT INTO users (username, password_hash, role) VALUES (?,?,?)');
    await ins.run('admin', await hashPassword('admin123'), 'ADMIN');
    await ins.run('operator', await hashPassword('operator123'), 'OPERATOR');
    log('seeded users: admin/admin123, operator/operator123');
  }
}
