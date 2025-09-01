// electron/db/index.ts
import fs from 'fs';
import path from 'path';

// === TIPI: usa i tipi namespaced senza importare il modulo come valore ===
import type * as BetterSqlite3 from 'better-sqlite3';

// === RUNTIME: otteniamo il costruttore CommonJS ===
const BetterSqlite3Ctor = require('better-sqlite3') as unknown as {
    new (file: string, options?: BetterSqlite3.Options): BetterSqlite3.Database;
};

type DBClass = BetterSqlite3.Database;

import { getPortableDataDir } from './paths';
import { hashPassword } from './utils';

let db: DBClass | null = null;

function log(...args: unknown[]) { console.log('[db]', ...args); }

/** Risolve il percorso di schema.sql sia in DEV che in BUILD (outDir = "dist"). */
function resolveSchemaPath(): string {
    const here = __dirname;            // es.: dist/db  (in dev è la cartella di build)
    const cwd  = process.cwd();        // root del progetto o app bundle CWD in packaged

    const candidates = [
        path.join(here, 'schema.sql'),                  // BUILD: dist/db/schema.sql
        path.join(cwd, 'electron', 'db', 'schema.sql'), // DEV:   electron/db/schema.sql
    ];

    console.log(
        '[db] diagnostics:',
        '\n  __filename  =', __filename,
        '\n  __dirname   =', here,
        '\n  process.cwd =', cwd,
        '\n  candidates  =\n   -', candidates.join('\n   - ')
    );

    for (const p of candidates) {
        const exists = fs.existsSync(p);
        console.log('[db] check exists:', p, '->', exists ? 'YES' : 'NO');
        if (exists) return p;
    }
    throw new Error(
        'schema.sql non trovato:\n' +
        candidates.map(c => ' - ' + c).join('\n')
    );
}

function cleanupWalShm(dbFile: string) {
    for (const ext of ['', '-wal', '-shm']) {
        const f = `${dbFile}${ext}`;
        if (fs.existsSync(f)) {
            try { fs.unlinkSync(f); log('removed', f); }
            catch (e) { console.warn('[db] unlink failed', f, e); }
        }
    }
}

export function getDB(): DBClass {
    if (!db) throw new Error('DB not initialized. Call initDB() first.');
    return db;
}

export async function initDB() {
    const DB_DIR  = getPortableDataDir(); // ./data (dev) oppure Contents/MacOS/data (packaged)
    try { fs.mkdirSync(DB_DIR, { recursive: true }); } catch {}
    const DB_FILE = path.join(DB_DIR, 'app.db');
    const firstCreate = !fs.existsSync(DB_FILE);

    // 1) Apri il DB
    db = new BetterSqlite3Ctor(DB_FILE);

    // 2) PRAGMA con retry se troviamo WAL/SHM corrotti (SQLITE_IOERR)
    try {
        db.pragma('journal_mode = WAL');
    } catch (e: any) {
        const msg = String(e?.message ?? e);
        if (msg.includes('SQLITE_IOERR')) {
            log('IOERR on PRAGMA WAL, attempting cleanup & reopen…');
            try { (db as any).close?.(); } catch {}
            cleanupWalShm(DB_FILE);
            db = new BetterSqlite3Ctor(DB_FILE);
            db.pragma('journal_mode = WAL'); // retry
        } else {
            throw e;
        }
    }

    db.pragma('synchronous = NORMAL');
    db.pragma('foreign_keys = ON');

    // 3) DDL (baseline v1)
    const SCHEMA = resolveSchemaPath();
    log('using schema:', SCHEMA);
    const ddl = fs.readFileSync(SCHEMA, 'utf8');
    db.exec(ddl);

    // 4) Seed minimi
    const row = db.prepare('SELECT COUNT(*) c FROM users').get() as { c: number } | undefined;
    if (firstCreate || !row || row.c === 0) {
        const ins = db.prepare('INSERT INTO users (username, password_hash, role) VALUES (?,?,?)');
        ins.run('admin',   await hashPassword('admin123'),   'ADMIN');
        ins.run('operator',await hashPassword('operator123'),'OPERATOR');
        log('seeded users: admin/admin123, operator/operator123');
    }
}