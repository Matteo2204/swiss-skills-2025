// electron/db/migrate.ts
import fs from 'fs';
import path from 'path';
import type DatabaseNS from 'better-sqlite3';
import { getDB } from './index';

type DB = DatabaseNS.Database;

function log(...a: unknown[]) { console.log('[migrate]', ...a); }

/** Legge la versione attuale da app_meta (fallback 1 se non c’è) */
export function getSchemaVersion(db: DB): number {
    const row = db.prepare("SELECT value FROM app_meta WHERE key='schema_version'")
        .get() as { value: string } | undefined;
    return row ? Number(row.value) : 1;
}

function setSchemaVersion(db: DB, v: number) {
    db.prepare("INSERT INTO app_meta(key,value) VALUES('schema_version',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value")
        .run(String(v));
    db.pragma(`user_version = ${v}`); // opzionale: tieni allineato anche PRAGMA user_version
}

function backupDbFile(dbFile: string) {
    try {
        const dir = path.dirname(dbFile);
        const ts = new Date().toISOString().replace(/[-:T]/g,'').slice(0,15);
        const bak = path.join(dir, `app.db.bak.${ts}`);
        fs.copyFileSync(dbFile, bak);
        log('backup created:', bak);
    } catch (e) {
        log('backup failed (continuo comunque):', (e as Error)?.message);
    }
}

/** Pattern di migrazione */
interface Migration {
    id: number;      // versione target dopo questa migrazione
    name: string;    // per log
    up: (db: DB) => void;
}

const MIGRATIONS: Migration[] = [
];

/** Esegue tutte le migrazioni mancanti in ordine, in transazione per step */
export function runMigrationsIfNeeded(dbFile: string) {
    const db = getDB();
    let current = getSchemaVersion(db);
    const latest = MIGRATIONS.length ? Math.max(...MIGRATIONS.map(m => m.id)) : current;

    if (current >= latest) {
        log(`up-to-date (v${current})`);
        return;
    }

    log(`from v${current} → v${latest}`);
    backupDbFile(dbFile);

    for (const m of MIGRATIONS.sort((a,b)=>a.id-b.id)) {
        if (m.id <= current) continue;
        log(`applying #${m.id} ${m.name} ...`);
        db.exec('BEGIN');
        try {
            m.up(db);
            setSchemaVersion(db, m.id);
            db.exec('COMMIT');
            current = m.id;
            log(`done #${m.id}`);
        } catch (e) {
            db.exec('ROLLBACK');
            log(`FAILED #${m.id}:`, (e as Error)?.message);
            throw e;
        }
    }

    log('all migrations applied.');
}