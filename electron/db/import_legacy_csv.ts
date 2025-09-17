/**
 * Importa un CSV legacy (mowers + telemetrie) nel nuovo schema MySQL (mower_*)
 *
 * CLI:
 *   npm run import:csv -- --file <path> [--tz Europe/Zurich] [--dry-run] [--batch 500]
 *
 * Vincoli:
 * - Nessuna dipendenza extra (usa solo node + mysql2/promise)
 * - Streaming CSV con parser manuale (",", quote ") e escape ""
 * - Best-effort, idempotente (INSERT IGNORE su serie), prepared statements, transazioni per batch
 * - Riconnessione 1 volta/batch su PROTOCOL_CONNECTION_LOST
 */

import fs from 'fs';
import path from 'path';
import mysql, { Pool, PoolOptions } from 'mysql2/promise';

type Opts = { file: string; tz: string; dryRun: boolean; batch: number };

function parseArgs(argv: string[]): Opts {
  const out: Opts = { file: '', tz: 'Europe/Zurich', dryRun: false, batch: 500 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--file' || a === '-f') {
      out.file = argv[++i] ?? '';
    } else if (a === '--tz') {
      out.tz = argv[++i] ?? out.tz;
    } else if (a === '--dry-run') {
      out.dryRun = true;
    } else if (a === '--batch') {
      const n = Number(argv[++i]);
      if (Number.isFinite(n) && n > 0) out.batch = Math.floor(n);
    }
  }
  if (!out.file) {
    console.error('Usage: --file <path> [--tz Europe/Zurich] [--dry-run] [--batch 500]');
    process.exit(2);
  }
  return out;
}

function env(name: string, fallback: string): string {
  const v = process.env[name];
  return v == null || v === '' ? fallback : v;
}

function sanitizeText(s: string | undefined | null): string {
  if (!s) return '';
  let x = String(s);
  x = x.replace(/[\u2026…]+/g, ''); // rimuovi ellissi …
  x = x.replace(/\.{3,}/g, '');     // rimuovi '...'
  x = x.replace(/[\r\n\t]+/g, ' ');
  x = x.replace(/\s+/g, ' ').trim();
  return x;
}

function normDecimal(s: string | undefined | null): string {
  if (!s) return '';
  return sanitizeText(s).replace(/,/g, '.');
}

function toNumberOrNull(s: string | undefined | null): number | null {
  const n = Number(normDecimal(s));
  return Number.isFinite(n) ? n : null;
}

function round1(n: number): number { return Math.round(n * 10) / 10; }

function clampBattery(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.min(100, Math.max(0, round1(n)));
}

function pad2(n: number): string { return n < 10 ? '0' + n : String(n); }
function pad3(n: number): string { return n < 10 ? '00' + n : (n < 100 ? '0' + n : String(n)); }

function formatDateInTZ(d: Date, tz: string): string {
  // Usa Intl per estrarre componenti nella TZ richiesta
  const fmt = new Intl.DateTimeFormat('en-GB', {
    timeZone: tz,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  });
  const parts = fmt.formatToParts(d);
  const get = (t: string) => parts.find(p => p.type === t)?.value ?? '00';
  const yyyy = parts.find(p => p.type === 'year')?.value ?? '1970';
  const MM = parts.find(p => p.type === 'month')?.value ?? '01';
  const dd = parts.find(p => p.type === 'day')?.value ?? '01';
  const HH = parts.find(p => p.type === 'hour')?.value ?? '00';
  const mm = parts.find(p => p.type === 'minute')?.value ?? '00';
  const ss = parts.find(p => p.type === 'second')?.value ?? '00';
  const ms = pad3(d.getMilliseconds()); // frazioni non dipendono dal fuso
  return `${yyyy}-${MM}-${dd} ${HH}:${mm}:${ss}.${ms}`;
}

function normalizeNaiveLocalDateTime(s: string): string | null {
  // Converte formati comuni in 'YYYY-MM-DD HH:mm:ss.SSS' senza cambio fuso
  let x = sanitizeText(s).replace('T', ' ').replace(/\//g, '-');
  if (!x) return null;
  const m = x.match(/^(\d{4})-(\d{1,2})-(\d{1,2})(?:[ T](\d{1,2}):(\d{1,2})(?::(\d{1,2})(?:\.(\d{1,3}))?)?)?$/);
  if (!m) return null;
  const [_, y, mo, d, h='00', mi='00', se='00', ms='000'] = m;
  const yyyy = y.padStart(4, '0');
  const MM = pad2(Number(mo));
  const dd = pad2(Number(d));
  const HH = pad2(Number(h));
  const mm = pad2(Number(mi));
  const ss = pad2(Number(se));
  const mss = pad3(Number(ms));
  return `${yyyy}-${MM}-${dd} ${HH}:${mm}:${ss}.${mss}`;
}

function parseTimestampToLocal(sRaw: string, tz: string): string | null {
  const s = sanitizeText(sRaw);
  if (!s) return null;
  // Numeric epoch?
  if (/^\d{10}$/.test(s)) {
    const d = new Date(Number(s) * 1000);
    return formatDateInTZ(d, tz);
  }
  if (/^\d{13}$/.test(s)) {
    const d = new Date(Number(s));
    return formatDateInTZ(d, tz);
  }
  // ISO with timezone (Z or +/-)
  if (/Z|[+-]\d{2}:?\d{2}$/.test(s)) {
    const d = new Date(s);
    if (isNaN(d.getTime())) return null;
    return formatDateInTZ(d, tz);
  }
  // Naive local-like
  const n = normalizeNaiveLocalDateTime(s);
  return n;
}

function detectDelimiter(filePath: string): ','|'\t' {
  try {
    const head = fs.readFileSync(filePath, 'utf8').split(/\r?\n/, 1)[0] ?? '';
    const cCommas = (head.match(/,/g) || []).length;
    const cTabs = (head.match(/\t/g) || []).length;
    return cTabs > cCommas ? '\t' : ',';
  } catch {
    return ',';
  }
}

// CSV/TSV streaming parser (supports comma or tab, quotes, double-quote escape)
async function* parseCsv(filePath: string, delim: ','|'\t'): AsyncGenerator<string[]> {
  const stream = fs.createReadStream(filePath, { encoding: 'utf8' });
  let buf = '';
  let i = 0;
  let row: string[] = [];
  let field = '';
  let inQuotes = false;

  for await (const chunk of stream) {
    buf += chunk;
    for (; i < buf.length; i++) {
      const ch = buf[i];
      if (inQuotes) {
        if (ch === '"') {
          const next = buf[i + 1];
          if (next === '"') { field += '"'; i++; continue; }
          inQuotes = false; // consume closing quote
        } else {
          field += ch;
        }
      } else {
        if (ch === '"') {
          inQuotes = true;
        } else if (ch === delim) {
          row.push(field); field = '';
        } else if (ch === '\n') {
          row.push(field); field = '';
          // Handle CRLF where CR was before LF
          if (row.length === 1 && row[0] === '' && buf[i-1] === '\r') { /* skip */ }
          yield row; row = [];
        } else if (ch === '\r') {
          // lookahead for \n; we'll let \n flush the row
        } else {
          field += ch;
        }
      }
    }
    // reset and keep leftover
    buf = buf.slice(i);
    i = 0;
  }
  // flush last field/row
  row.push(field);
  // if trailing empty line, skip emitting empty row
  if (!(row.length === 1 && row[0] === '')) {
    yield row;
  }
}

function normalizeHeaderKey(s: string): string {
  return s.toLowerCase().replace(/[_.\s]/g, '');
}

function findCol(headers: string[], patterns: string[]): number {
  const norm = headers.map(normalizeHeaderKey);
  let bestIdx = -1;
  let bestScore = 0;
  for (let i = 0; i < norm.length; i++) {
    const h = norm[i];
    for (const p of patterns) {
      let score = 0;
      if (h === p) score = 3;               // exact match
      else if (h.startsWith(p)) score = 2;  // prefix match
      else if (h.includes(p)) score = 1;    // substring match
      if (score > bestScore) { bestScore = score; bestIdx = i; }
    }
  }
  return bestIdx;
}

type ColMap = {
  name: number; vendor: number; model: number; serial: number; firmware: number;
  homeLat: number; homeLon: number;
  addr: number; postal: number; city: number; canton: number;
  ts: number; lat: number; lon: number; state: number; battery: number; tz: number;
};

function buildColMap(headers: string[]): ColMap {
  return {
    name:   findCol(headers, ['name','mowername']),
    vendor: findCol(headers, ['vendor']),
    model:  findCol(headers, ['model']),
    serial: findCol(headers, ['serialnumber','serialno','serial']),
    firmware: findCol(headers, ['firmware','fw']),
    homeLat: findCol(headers, ['homelatitude','homelat']),
    homeLon: findCol(headers, ['homelongitude','homelon','homelong']),
    addr:   findCol(headers, ['addressline','address1','address']),
    postal: findCol(headers, ['postalcode','postcode','zip']),
    city:   findCol(headers, ['city','town']),
    canton: findCol(headers, ['canton']),
    ts:     findCol(headers, ['timestamp','datetime','time','ts']),
    lat:    findCol(headers, ['latitude','lat']),
    lon:    findCol(headers, ['longitude','lon','lng']),
    state:  findCol(headers, ['devicestate','state']),
    battery:findCol(headers, ['batterylevel','battery']),
    tz:     findCol(headers, ['timezone','tz']),
  };
}

function deriveNameFromLocation(city?: string, postal?: string, addr?: string): string {
  const parts = [sanitizeText(city), sanitizeText(postal), sanitizeText(addr)].filter(Boolean);
  const s = parts.join('-').slice(0, 120);
  return s || 'mower-unknown';
}

// DB helpers
type DB = { pool: Pool };

async function createPool(): Promise<Pool> {
  const host = env('MYSQL_HOST', 'localhost');
  const port = Number(env('MYSQL_PORT', '3306'));
  const user = env('MYSQL_USER', 'root');
  const password = env('MYSQL_PASSWORD', 'ictskills');
  const database = env('MYSQL_DATABASE', 'ictskills');
  const opts: PoolOptions = {
    host, port, user, password, database,
    waitForConnections: true,
    connectionLimit: 10,
    multipleStatements: false,
  };
  return mysql.createPool(opts);
}

async function ensureMower(pool: Pool, cache: Map<string, number>, name: string, vendor?: string, model?: string, serial?: string, firmware?: string, homeLat?: number|null, homeLon?: number|null, dryRun = false): Promise<{ id: number; created: boolean }> {
  const existing = cache.get(name);
  if (existing) return { id: existing, created: false };
  // check DB first
  const [rows] = await pool.query<any[]>('SELECT id FROM mower WHERE name = ?', [name]);
  if (Array.isArray(rows) && rows.length) {
    const id = Number(rows[0].id);
    cache.set(name, id);
    return { id, created: false };
  }
  // insert (skip in dry-run)
  if (dryRun) {
    // Simula nuovo ID con -1 (non usato nei write in dry-run)
    return { id: -1, created: true };
  }
  const [res] = await pool.execute<any>(
    'INSERT INTO mower (name, vendor, model, serial_number, firmware, home_lat, home_lon) VALUES (?,?,?,?,?,?,?)',
    [name, vendor || null, model || null, serial || null, firmware || null, homeLat ?? null, homeLon ?? null]
  );
  const insertId = (res && typeof res.insertId === 'number') ? res.insertId : undefined;
  if (!insertId) {
    // last resort: reselect (race or permissions)
    const [r2] = await pool.query<any[]>('SELECT id FROM mower WHERE name = ?', [name]);
    if (Array.isArray(r2) && r2.length) {
      const id = Number(r2[0].id);
      cache.set(name, id);
      return { id, created: false };
    }
    throw new Error('Failed to insert mower and no id retrievable');
  }
  cache.set(name, insertId);
  return { id: insertId, created: true };
}

type StateRec = { mowerId: number; ts: string; state: string };
type BattRec  = { mowerId: number; ts: string; level: number };
type GPSRec   = { mowerId: number; ts: string; lat: number; lon: number };

async function insertBatch(pool: Pool, states: StateRec[], batts: BattRec[], gps: GPSRec[]) {
  if (states.length === 0 && batts.length === 0 && gps.length === 0) return { s:0, b:0, g:0 };
  const conn = await pool.getConnection();
  try {
    await conn.query('START TRANSACTION');
    let sIns = 0, bIns = 0, gIns = 0;
    if (states.length) {
      const sql = 'INSERT IGNORE INTO mower_state (mower_id, ts, state) VALUES ' + states.map(()=>'(?,?,?)').join(',');
      const params: any[] = [];
      for (const r of states) { params.push(r.mowerId, r.ts, r.state); }
      const [res]: any = await conn.query(sql, params);
      sIns += (res?.affectedRows ?? 0);
    }
    if (batts.length) {
      const sql = 'INSERT IGNORE INTO mower_battery (mower_id, ts, level) VALUES ' + batts.map(()=>'(?,?,?)').join(',');
      const params: any[] = [];
      for (const r of batts) { params.push(r.mowerId, r.ts, r.level); }
      const [res]: any = await conn.query(sql, params);
      bIns += (res?.affectedRows ?? 0);
    }
    if (gps.length) {
      const sql = 'INSERT IGNORE INTO mower_gps (mower_id, ts, lat, lon) VALUES ' + gps.map(()=>'(?,?,?,?)').join(',');
      const params: any[] = [];
      for (const r of gps) { params.push(r.mowerId, r.ts, r.lat, r.lon); }
      const [res]: any = await conn.query(sql, params);
      gIns += (res?.affectedRows ?? 0);
    }
    await conn.query('COMMIT');
    return { s: sIns, b: bIns, g: gIns };
  } catch (e) {
    try { await conn.query('ROLLBACK'); } catch {}
    throw e;
  } finally {
    conn.release();
  }
}

export type ImportLegacyOptions = { tz?: string; dryRun?: boolean; batch?: number };
export type ImportLegacyResult = {
  rowsRead: number;
  mowersCreated: number;
  mowersReused: number;
  statesInserted: number;
  battsInserted: number;
  gpsInserted: number;
};

export async function importLegacyFromCSV(filePath: string, options?: ImportLegacyOptions): Promise<ImportLegacyResult> {
  const opts = {
    file: filePath,
    tz: options?.tz ?? 'Europe/Zurich',
    dryRun: options?.dryRun ?? false,
    batch: options?.batch ?? 500,
  };
  const csvPath = path.resolve(opts.file);
  if (!fs.existsSync(csvPath)) {
    console.error('File non trovato:', csvPath);
    throw new Error('CSV non trovato: ' + csvPath);
  }

  let pool = await createPool();
  const mowerCache = new Map<string, number>();

  // Stats
  let rowsRead = 0;
  let statesInserted = 0, battsInserted = 0, gpsInserted = 0;
  const discards: string[] = [];
  let mowersCreated = 0, mowersReused = 0;
  const createdNames = new Set<string>();
  const reusedNames = new Set<string>();

  const statesBatch: StateRec[] = [];
  const battsBatch: BattRec[] = [];
  const gpsBatch: GPSRec[] = [];

  const sampleSql: { type: string; sql: string; params: any[] }[] = [];

  let headers: string[] | null = null;
  let cmap: ColMap | null = null;

  const delim = detectDelimiter(csvPath);
  for await (const row of parseCsv(csvPath, delim)) {
    // Alcune sorgenti hanno PurchaseDate spezzata in due colonne (es. "Apr 12" + "2021").
    // Se rileviamo una colonna in più rispetto all'header, proviamo a fonderla.
    if (headers && row.length === headers.length + 1) {
      const pdIdx = findCol(headers, ['purchasedate']);
      if (pdIdx >= 0 && (pdIdx + 1) < row.length) {
        row[pdIdx] = [row[pdIdx], row[pdIdx + 1]].filter(Boolean).join(' ');
        row.splice(pdIdx + 1, 1);
      }
    }
    // Skip empty rows
    if (!headers) {
      headers = row.map(sanitizeText);
      cmap = buildColMap(headers);
      continue;
    }

    rowsRead++;
    const get = (idx: number) => idx >= 0 && idx < row.length ? row[idx] : '';
    const nameRaw = sanitizeText(get(cmap!.name));
    const vendor = sanitizeText(get(cmap!.vendor));
    const model = sanitizeText(get(cmap!.model));
    const serial = sanitizeText(get(cmap!.serial));
    const firmware = sanitizeText(get(cmap!.firmware));
    const homeLat = toNumberOrNull(get(cmap!.homeLat));
    const homeLon = toNumberOrNull(get(cmap!.homeLon));
    const addr = sanitizeText(get(cmap!.addr));
    const postal = sanitizeText(get(cmap!.postal));
    const city = sanitizeText(get(cmap!.city));
    const tzRow = sanitizeText(get(cmap!.tz)) || opts.tz;
    const tsRaw = sanitizeText(get(cmap!.ts));

    let name = nameRaw || deriveNameFromLocation(city, postal, addr);
    if (!name) {
      if (discards.length < 10) discards.push(`riga ${rowsRead}: name mancante`);
      continue;
    }
    if (name.length > 120) name = name.slice(0, 120);

    const ts = parseTimestampToLocal(tsRaw, tzRow || opts.tz);
    if (!ts) {
      if (discards.length < 10) discards.push(`riga ${rowsRead}: timestamp invalido`);
      continue;
    }

    // Ensure mower id (dry-run: non scrive, ma controlla esistenza)
    let mowerId: number | null = null;
    try {
      const { id, created } = await ensureMower(pool, mowerCache, name, vendor || undefined, model || undefined, serial || undefined, firmware || undefined, homeLat, homeLon, opts.dryRun);
      if (created) createdNames.add(name); else reusedNames.add(name);
      mowerId = id;
    } catch (e) {
      if (discards.length < 10) discards.push(`riga ${rowsRead}: errore ensure mower ${(e as Error).message}`);
      continue;
    }

    const stateRaw = sanitizeText(get(cmap!.state));
    const battRaw = normDecimal(get(cmap!.battery));
    const latRaw = normDecimal(get(cmap!.lat));
    const lonRaw = normDecimal(get(cmap!.lon));

    // Telemetry rows: add if present
    if (stateRaw) statesBatch.push({ mowerId: mowerId!, ts, state: stateRaw });
    if (battRaw) {
      const bn = Number(battRaw);
      if (Number.isFinite(bn)) battsBatch.push({ mowerId: mowerId!, ts, level: clampBattery(bn) });
    }
    if (latRaw && lonRaw) {
      const lat = Number(latRaw), lon = Number(lonRaw);
      if (Number.isFinite(lat) && Number.isFinite(lon)) gpsBatch.push({ mowerId: mowerId!, ts, lat, lon });
    }

    // Flush per batch size
    if ((rowsRead % opts.batch) === 0) {
      if (opts.dryRun) {
        // Accumula sample SQL (prime 3 per tipo)
        if (sampleSql.length < 9) {
          if (statesBatch.length && sampleSql.filter(s=>s.type==='state').length < 3) sampleSql.push({ type: 'state', sql: 'INSERT IGNORE INTO mower_state (mower_id, ts, state) VALUES (?,?,?)', params: [statesBatch[0].mowerId, statesBatch[0].ts, statesBatch[0].state] });
          if (battsBatch.length && sampleSql.filter(s=>s.type==='battery').length < 3) sampleSql.push({ type: 'battery', sql: 'INSERT IGNORE INTO mower_battery (mower_id, ts, level) VALUES (?,?,?)', params: [battsBatch[0].mowerId, battsBatch[0].ts, battsBatch[0].level] });
          if (gpsBatch.length && sampleSql.filter(s=>s.type==='gps').length < 3) sampleSql.push({ type: 'gps', sql: 'INSERT IGNORE INTO mower_gps (mower_id, ts, lat, lon) VALUES (?,?,?,?)', params: [gpsBatch[0].mowerId, gpsBatch[0].ts, gpsBatch[0].lat, gpsBatch[0].lon] });
        }
        // non scrive su DB; svuota i batch per limitare memoria
        statesBatch.length = 0; battsBatch.length = 0; gpsBatch.length = 0;
      } else {
        let attempt = 0;
        while (true) {
          try {
            const { s, b, g } = await insertBatch(pool, statesBatch, battsBatch, gpsBatch);
            statesInserted += s; battsInserted += b; gpsInserted += g;
            statesBatch.length = 0; battsBatch.length = 0; gpsBatch.length = 0;
            break;
          } catch (e: any) {
            if (e && e.code === 'PROTOCOL_CONNECTION_LOST' && attempt < 1) {
              attempt++;
              console.warn('connessione persa; tento riconnessione una volta...');
              try { await pool.end(); } catch {}
              pool = await createPool();
              continue;
            }
            throw e;
          }
        }
      }
    }
  }

  // flush rimanenti
  if (opts.dryRun) {
    if (sampleSql.length < 9) {
      if (statesBatch.length && sampleSql.filter(s=>s.type==='state').length < 3) sampleSql.push({ type: 'state', sql: 'INSERT IGNORE INTO mower_state (mower_id, ts, state) VALUES (?,?,?)', params: [statesBatch[0].mowerId, statesBatch[0].ts, statesBatch[0].state] });
      if (battsBatch.length && sampleSql.filter(s=>s.type==='battery').length < 3) sampleSql.push({ type: 'battery', sql: 'INSERT IGNORE INTO mower_battery (mower_id, ts, level) VALUES (?,?,?)', params: [battsBatch[0].mowerId, battsBatch[0].ts, battsBatch[0].level] });
      if (gpsBatch.length && sampleSql.filter(s=>s.type==='gps').length < 3) sampleSql.push({ type: 'gps', sql: 'INSERT IGNORE INTO mower_gps (mower_id, ts, lat, lon) VALUES (?,?,?,?)', params: [gpsBatch[0].mowerId, gpsBatch[0].ts, gpsBatch[0].lat, gpsBatch[0].lon] });
    }
  } else {
    const { s, b, g } = await insertBatch(pool, statesBatch, battsBatch, gpsBatch);
    statesInserted += s; battsInserted += b; gpsInserted += g;
  }

  mowersCreated = createdNames.size;
  mowersReused = reusedNames.size;

  // Output
  console.log('--- Import CSV (best-effort) ---');
  console.log('File:', csvPath);
  console.log('Rows lette:', rowsRead);
  console.log('Mowers: creati ~', mowersCreated, 'riusati ~', mowersReused);
  console.log('Inseriti: state=', statesInserted, 'battery=', battsInserted, 'gps=', gpsInserted);
  if (discards.length) {
    console.log('Scartate (prime 10):');
    for (const d of discards) console.log(' -', d);
  }
  if (opts.dryRun) {
    console.log('--- DRY RUN: prime 3 istruzioni simulate per tipo ---');
    let count = 0;
    for (const t of ['state','battery','gps']) {
      const samples = sampleSql.filter(s => s.type === t).slice(0,3);
      for (const s of samples) {
        console.log(`> ${s.sql}  -- params:`, JSON.stringify(s.params));
        count++;
      }
    }
    if (count === 0) console.log('(nessuna)');
  }

  try { await pool.end(); } catch {}

  return {
    rowsRead,
    mowersCreated,
    mowersReused,
    statesInserted,
    battsInserted,
    gpsInserted,
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  await importLegacyFromCSV(args.file, { tz: args.tz, dryRun: args.dryRun, batch: args.batch });
}

if (require.main === module) {
  main().catch(err => {
    console.error('Errore import:', err?.message || err);
    process.exit(1);
  });
}
