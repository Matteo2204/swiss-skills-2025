// electron/db/index.ts (MySQL adapter)
import fs from 'fs';
import path from 'path';
import type { Pool, PoolOptions, ResultSetHeader } from 'mysql2/promise';
import mysql from 'mysql2/promise';
import { hashPassword } from './utils';
import { ensureLocalMysqlIfNeeded } from './mysql-server';
import { getPortableDataDir } from './paths';

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
          if (code === 'ER_DUP_KEYNAME' || code === 1061) continue;
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
  // If no external env present, attempt to start local sidecar
  let localInfo: { host: string; port: number; user: string; password: string; database: string; socketPath?: string } | null = null;
  try {
    const baseDir = getPortableDataDir();
    localInfo = await ensureLocalMysqlIfNeeded(baseDir);
  } catch (e) {
    // If sidecar fails and external env is missing, we will error below via env()
    log('Sidecar not used or failed:', (e as Error)?.message);
  }

  // Read connection details from env or from sidecar
  const host = localInfo?.host ?? env('MYSQL_HOST', 'localhost');
  const port = localInfo?.port ?? Number(env('MYSQL_PORT', '3306'));
  const user = localInfo?.user ?? env('MYSQL_USER');
  const password = localInfo?.password ?? env('MYSQL_PASSWORD', '');
  const database = localInfo?.database ?? env('MYSQL_DATABASE');

  const baseOpts: PoolOptions = {
    host,
    port,
    user,
    password,
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0,
    multipleStatements: false,
  };
  if (localInfo?.socketPath) {
    // Prefer Unix socket on macOS/Linux to ensure root@localhost works during bootstrap
    (baseOpts as any).socketPath = localInfo.socketPath;
  }

  // If using external env, ensure database exists with provided user
  if (!localInfo) {
    const rootPool = await mysql.createPool(baseOpts);
    try {
      await ensureDatabaseExists(rootPool, database);
    } finally {
      await rootPool.end();
    }
  }

  // Create pool bound to the application database
  const finalOpts: PoolOptions = { ...baseOpts, database };
  pool = await mysql.createPool(finalOpts);
  db = buildWrapper(pool);

  // Apply schema
  const schemaPath = resolveMysqlSchemaPath();
  log('using schema:', schemaPath);
  const ddl = fs.readFileSync(schemaPath, 'utf8');
  await db.exec(ddl);

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
