import express from 'express';
import { getDB } from '../db';
import { requireRole } from '../ipc/auth';

// Minimal, self-contained router for lawnmower CRUD + list with equals filters
export const mowersRouter = express.Router();

type MowerRow = {
  id: number;
  name: string;
  address?: string|null;
  postal_code?: string|null;
  city?: string|null;
  canton?: string|null;
  vendor?: string|null;
  model?: string|null;
  serial_number?: string|null;
  firmware?: string|null;
  home_lat?: number|null|string;
  home_lon?: number|null|string;
  purchase_date?: string|null|Date;
  latest_maintenance?: string|null|Date;
  currentState?: string|null;
  currentBatteryLevel?: number|null|string;
  currentLatitude?: number|null|string;
  currentLongitude?: number|null|string;
};

function toDateOnlyString(d: string | Date | null | undefined): string | undefined {
  if (d == null) return undefined;
  if (typeof d === 'string') {
    const m = d.match(/^(\d{4}-\d{2}-\d{2})/);
    return m ? m[1] : d;
  }
  if (d instanceof Date && !isNaN(d.getTime())) {
    const yyyy = d.getFullYear();
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');
    return `${yyyy}-${mm}-${dd}`;
  }
  return undefined;
}

function mapMower(row: MowerRow) {
  const n = (v: any) => (v == null || v === '') ? undefined : Number(v);
  return {
    id: row.id,
    name: row.name,
    address: row.address ?? undefined,
    postalCode: row.postal_code ?? undefined,
    city: row.city ?? undefined,
    canton: row.canton ?? undefined,
    homeLatitude: n(row.home_lat),
    homeLongitude: n(row.home_lon),
    serialNumber: row.serial_number ?? undefined,
    vendor: row.vendor ?? undefined,
    model: row.model ?? undefined,
    firmwareVersion: row.firmware ?? undefined,
    purchaseDate: toDateOnlyString(row.purchase_date as any),
    latestMaintenance: toDateOnlyString(row.latest_maintenance as any),
    currentLatitude: n(row.currentLatitude),
    currentLongitude: n(row.currentLongitude),
    currentBatteryLevel: n(row.currentBatteryLevel),
    currentState: row.currentState ?? undefined,
  };
}

function extractToken(req: express.Request): string | undefined {
  // Accept Authorization: Bearer <token>, or X-Auth-Token header, or query token
  const h = req.header('authorization') || req.header('Authorization');
  if (h && /^Bearer\s+/i.test(h)) return h.replace(/^Bearer\s+/i, '').trim();
  const x = req.header('x-auth-token') || req.header('X-Auth-Token');
  if (x) return x.trim();
  const q = (req.query?.token as string | undefined)?.trim();
  return q || undefined;
}

function withRole(roles: Array<'ADMIN' | 'OPERATOR'>) {
  return async (req: express.Request, res: express.Response, next: express.NextFunction) => {
    try {
      const token = extractToken(req);
      await requireRole(token, roles);
      return next();
    } catch (e: any) {
      const msg = String(e?.message || e || 'UNAUTHORIZED');
      if (msg === 'FORBIDDEN') return res.status(403).json({ error: 'FORBIDDEN' });
      return res.status(401).json({ error: 'UNAUTHORIZED' });
    }
  };
}

function badRequest(res: express.Response, err: any) {
  const code = err?.code ?? err?.errno ?? 'DB_ERROR';
  const message = err?.sqlMessage || err?.message || 'DB_ERROR';
  return res.status(400).json({ error: 'DB_ERROR', code, message });
}

// Assignment-specific: respond with HTTP/1.1 400 "invalid input" for validation errors
function invalidInput(res: express.Response) {
  try { (res as any).statusMessage = 'invalid input'; } catch {}
  return res.status(400).send('invalid input');
}

// GET /api/lawnmowers?name&vendor&id
mowersRouter.get('/lawnmowers', withRole(['ADMIN', 'OPERATOR']), async (req, res) => {
  try {
    const db = getDB();
    const filters: string[] = [];
    const args: any[] = [];
    if (req.query.id != null && String(req.query.id).trim() !== '') {
      filters.push('mower_id = ?');
      args.push(Number(req.query.id));
    }
    if (req.query.name != null && String(req.query.name).trim() !== '') {
      filters.push('name = ?');
      args.push(String(req.query.name));
    }
    if (req.query.vendor != null && String(req.query.vendor).trim() !== '') {
      filters.push('vendor = ?');
      args.push(String(req.query.vendor));
    }
    const where = filters.length ? 'WHERE ' + filters.join(' AND ') : '';
    const sql = `
      SELECT 
        mower_id AS id,
        name, address, postal_code, city, canton,
        vendor, model, serial_number, firmware,
        home_lat, home_lon,
        purchase_date, latest_maintenance,
        currentState, currentBatteryLevel, currentLatitude, currentLongitude
      FROM v_mower_current
      ${where}
      ORDER BY id
    `;
    const rows = await db.prepare(sql).all(...args) as MowerRow[];
    const out = rows.map(mapMower);
    return res.json(out);
  } catch (err) {
    return badRequest(res, err);
  }
});

// GET /api/lawnmower/:id
mowersRouter.get('/lawnmower/:id', withRole(['ADMIN', 'OPERATOR']), async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) return res.status(400).json({ error: 'INVALID_ID' });
    const row = await getDB().prepare(
      `SELECT mower_id AS id,
              name, address, postal_code, city, canton,
              vendor, model, serial_number, firmware,
              home_lat, home_lon,
              purchase_date, latest_maintenance,
              currentState, currentBatteryLevel, currentLatitude, currentLongitude
       FROM v_mower_current WHERE mower_id = ?`
    ).get(id) as MowerRow | undefined;
    if (!row) return res.status(404).json({ error: 'NOT_FOUND' });
    return res.json(mapMower(row));
  } catch (err) {
    return badRequest(res, err);
  }
});

// POST /api/lawnmower (ADMIN)
mowersRouter.post('/lawnmower', withRole(['ADMIN']), async (req, res) => {
  try {
    const body = req.body || {};
    const name = String(body.name ?? '').trim();
    if (!name) return invalidInput(res);

    const vendor = body.vendor != null ? String(body.vendor) : null;
    const model = body.model != null ? String(body.model) : null;
    // Accept both snake_case (existing) and camelCase (spec) inputs
    const serial_number = (body.serial_number ?? body.serialNumber) != null ? String(body.serial_number ?? body.serialNumber) : null;
    const firmware = (body.firmware ?? body.firmwareVersion) != null ? String(body.firmware ?? body.firmwareVersion) : null;
    const hasLat = (body.home_lat ?? body.homeLatitude) !== undefined && (body.home_lat ?? body.homeLatitude) !== null;
    const hasLon = (body.home_lon ?? body.homeLongitude) !== undefined && (body.home_lon ?? body.homeLongitude) !== null;
    const home_lat = hasLat ? Number(body.home_lat ?? body.homeLatitude) : null;
    const home_lon = hasLon ? Number(body.home_lon ?? body.homeLongitude) : null;

    // If provided, lat/lon must be finite numbers
    if ((hasLat && !Number.isFinite(home_lat)) || (hasLon && !Number.isFinite(home_lon))) {
      return invalidInput(res);
    }

    const db = getDB();
    const ins = db.prepare(
      'INSERT INTO mower (name, vendor, model, serial_number, firmware, home_lat, home_lon) VALUES (?,?,?,?,?,?,?)'
    );
    const r = await ins.run(name, vendor, model, serial_number, firmware, home_lat, home_lon);
    const id = Number(r.lastInsertRowid);

    // Defaults: current*
    const now = new Date();
    try {
      await db.prepare('INSERT INTO mower_state (mower_id, ts, state) VALUES (?,?,?)')
        .run(id, now, 'StationChargingCompleted');
    } catch {}
    try {
      await db.prepare('INSERT INTO mower_battery (mower_id, ts, level) VALUES (?,?,?)')
        .run(id, now, 100.0);
    } catch {}
    if (home_lat != null && home_lon != null && Number.isFinite(home_lat) && Number.isFinite(home_lon)) {
      try {
        await db.prepare('INSERT INTO mower_gps (mower_id, ts, lat, lon) VALUES (?,?,?,?)')
          .run(id, now, home_lat, home_lon);
      } catch {}
    }

    const row = await db.prepare(
      `SELECT mower_id AS id,
              name, address, postal_code, city, canton,
              vendor, model, serial_number, firmware,
              home_lat, home_lon,
              purchase_date, latest_maintenance,
              currentState, currentBatteryLevel, currentLatitude, currentLongitude
       FROM v_mower_current WHERE mower_id = ?`
    ).get(id) as MowerRow | undefined;
    return res.status(201).json(row ? mapMower(row) : undefined);
  } catch (err) {
    const code = (err as any)?.code ?? (err as any)?.errno;
    const asStr = String(code);
    // Map common MySQL validation/constraint errors to assignment-required 400 "invalid input"
    if (
      code === 1062 || asStr === 'ER_DUP_ENTRY' || // duplicate key
      code === 1048 || asStr === 'ER_BAD_NULL_ERROR' || // not null violation
      code === 1406 || asStr === 'ER_DATA_TOO_LONG' || // data too long
      code === 1264 || asStr === 'ER_WARN_DATA_OUT_OF_RANGE' || // out of range value
      code === 1292 || asStr === 'ER_TRUNCATED_WRONG_VALUE_FOR_FIELD' // wrong value
    ) {
      return invalidInput(res);
    }
    return badRequest(res, err);
  }
});

// PUT /api/lawnmower (ADMIN) — update base record
// Accepts body with fields (camelCase API):
// {
//   id, name, address, postalCode, city, canton,
//   homeLatitude, homeLongitude,
//   serialNumber, vendor, model, firmwareVersion,
//   purchaseDate, latestMaintenance
// }
// Responds 200 with the same fields plus: currentLatitude, currentLongitude, currentBatteryLevel, currentState
mowersRouter.put('/lawnmower', withRole(['ADMIN']), async (req, res) => {
  try {
    const body = req.body || {};

    // Basic validation
    const idRaw = body.id;
    const id = Number(idRaw);
    if (!Number.isFinite(id)) {
      res.statusMessage = 'invalid input';
      return res.status(400).json({ error: 'invalid input', field: 'id' });
    }

    // Validate optional numbers and dates
    const asNum = (v: any): number | null | undefined => {
      if (v === undefined) return undefined;
      if (v === null) return null;
      const n = Number(v);
      if (!Number.isFinite(n)) return NaN as any; // mark invalid
      return n;
    };
    const isDateStr = (s: string): boolean => /^\d{4}-\d{2}-\d{2}$/.test(s) && !isNaN(Date.parse(s));
    const asDate = (v: any): string | null | undefined => {
      if (v === undefined) return undefined;
      if (v === null || v === '') return null;
      const s = String(v);
      if (!isDateStr(s)) return 'INVALID' as any;
      return s;
    };

    // Map API fields -> DB columns
    const fields: Record<string, any> = {};
    const maybe = (k: string, v: any) => { if (v !== undefined) fields[k] = v; };
    maybe('name', body.name != null ? String(body.name) : undefined);
    maybe('address', body.address != null ? String(body.address) : undefined);
    maybe('postal_code', body.postalCode != null ? String(body.postalCode) : undefined);
    maybe('city', body.city != null ? String(body.city) : undefined);
    maybe('canton', body.canton != null ? String(body.canton) : undefined);
    maybe('vendor', body.vendor != null ? String(body.vendor) : undefined);
    maybe('model', body.model != null ? String(body.model) : undefined);
    maybe('serial_number', body.serialNumber != null ? String(body.serialNumber) : undefined);
    maybe('firmware', body.firmwareVersion != null ? String(body.firmwareVersion) : undefined);

    const homeLat = asNum(body.homeLatitude);
    if (homeLat === (NaN as any)) { res.statusMessage = 'invalid input'; return res.status(400).json({ error: 'invalid input', field: 'homeLatitude' }); }
    if (homeLat !== undefined) fields['home_lat'] = homeLat;
    const homeLon = asNum(body.homeLongitude);
    if (homeLon === (NaN as any)) { res.statusMessage = 'invalid input'; return res.status(400).json({ error: 'invalid input', field: 'homeLongitude' }); }
    if (homeLon !== undefined) fields['home_lon'] = homeLon;

    const purchaseDate = asDate(body.purchaseDate);
    if (purchaseDate === ('INVALID' as any)) { res.statusMessage = 'invalid input'; return res.status(400).json({ error: 'invalid input', field: 'purchaseDate' }); }
    if (purchaseDate !== undefined) fields['purchase_date'] = purchaseDate;

    const latestMaint = asDate(body.latestMaintenance);
    if (latestMaint === ('INVALID' as any)) { res.statusMessage = 'invalid input'; return res.status(400).json({ error: 'invalid input', field: 'latestMaintenance' }); }
    if (latestMaint !== undefined) fields['latest_maintenance'] = latestMaint;

    if (Object.keys(fields).length === 0) {
      res.statusMessage = 'invalid input';
      return res.status(400).json({ error: 'invalid input', message: 'no fields to update' });
    }

    const db = getDB();

    // Ensure id exists first to avoid false 404 on no-op updates
    const exists = await db.prepare('SELECT 1 AS ok FROM mower WHERE id = ?').get(id) as { ok: number } | undefined;
    if (!exists) return res.status(404).json({ error: 'NOT_FOUND' });

    const sets = Object.keys(fields).map(k => `${k} = ?`).join(', ');
    const args = [...Object.values(fields), id];
    await db.prepare(`UPDATE mower SET ${sets} WHERE id = ?`).run(...args);

    // Build response with requested shape
    const row = await db.prepare(
      `SELECT 
          m.id AS id,
          m.name,
          m.address,
          m.postal_code,
          m.city,
          m.canton,
          m.home_lat,
          m.home_lon,
          m.serial_number,
          m.vendor,
          m.model,
          m.firmware,
          DATE_FORMAT(m.purchase_date, '%Y-%m-%d') AS purchase_date,
          DATE_FORMAT(m.latest_maintenance, '%Y-%m-%d') AS latest_maintenance,
          vc.currentState,
          vc.currentBatteryLevel,
          vc.currentLatitude,
          vc.currentLongitude
       FROM mower m
       LEFT JOIN v_mower_current vc ON vc.mower_id = m.id
       WHERE m.id = ?`
    ).get(id) as any;

    if (!row) return res.status(404).json({ error: 'NOT_FOUND' });

    // Cast numbers for JSON response and map to API field names
    const toNum = (v: any) => (v == null ? null : Number(v));
    const resp = {
      id: Number(row.id),
      name: row.name ?? null,
      address: row.address ?? null,
      postalCode: row.postal_code ?? null,
      city: row.city ?? null,
      canton: row.canton ?? null,
      homeLatitude: toNum(row.home_lat),
      homeLongitude: toNum(row.home_lon),
      serialNumber: row.serial_number ?? null,
      vendor: row.vendor ?? null,
      model: row.model ?? null,
      firmwareVersion: row.firmware ?? null,
      purchaseDate: row.purchase_date ?? null,
      latestMaintenance: row.latest_maintenance ?? null,
      currentLatitude: toNum(row.currentLatitude),
      currentLongitude: toNum(row.currentLongitude),
      currentBatteryLevel: toNum(row.currentBatteryLevel),
      currentState: row.currentState ?? null,
    };

    res.statusMessage = 'Updated';
    return res.status(200).json(resp);
  } catch (err) {
    return badRequest(res, err);
  }
});

// DELETE /api/lawnmower/:id (ADMIN)
mowersRouter.delete('/lawnmower/:id', withRole(['ADMIN']), async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) return res.status(400).json({ error: 'INVALID_ID' });
    const r = await getDB().prepare('DELETE FROM mower WHERE id = ?').run(id);
    if (!r.changes) return res.status(404).json({ error: 'NOT_FOUND' });
    try { (res as any).statusMessage = 'Deleted'; } catch {}
    return res.status(204).send();
  } catch (err) {
    return badRequest(res, err);
  }
});
