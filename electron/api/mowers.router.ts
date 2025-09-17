import express from 'express';
import { getDB } from '../db';
import { requireRole } from '../ipc/auth';

// Minimal, self-contained router for lawnmower CRUD + list with equals filters
export const mowersRouter = express.Router();

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
        name, vendor, model, serial_number, firmware, home_lat, home_lon,
        currentState, currentBatteryLevel, currentLatitude, currentLongitude, currentTs
      FROM v_mower_current
      ${where}
      ORDER BY id
    `;
    const rows = await db.prepare(sql).all(...args);
    return res.json(rows);
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
              name, vendor, model, serial_number, firmware, home_lat, home_lon,
              currentState, currentBatteryLevel, currentLatitude, currentLongitude, currentTs
       FROM v_mower_current WHERE mower_id = ?`
    ).get(id);
    if (!row) return res.status(404).json({ error: 'NOT_FOUND' });
    return res.json(row);
  } catch (err) {
    return badRequest(res, err);
  }
});

// POST /api/lawnmower (ADMIN)
mowersRouter.post('/lawnmower', withRole(['ADMIN']), async (req, res) => {
  try {
    const body = req.body || {};
    const name = String(body.name ?? '').trim();
    if (!name) return res.status(400).json({ error: 'VALIDATION', message: 'name is required' });

    const vendor = body.vendor != null ? String(body.vendor) : null;
    const model = body.model != null ? String(body.model) : null;
    const serial_number = body.serial_number != null ? String(body.serial_number) : null;
    const firmware = body.firmware != null ? String(body.firmware) : null;
    const home_lat = body.home_lat != null ? Number(body.home_lat) : null;
    const home_lon = body.home_lon != null ? Number(body.home_lon) : null;

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
              name, vendor, model, serial_number, firmware, home_lat, home_lon,
              currentState, currentBatteryLevel, currentLatitude, currentLongitude, currentTs
       FROM v_mower_current WHERE mower_id = ?`
    ).get(id);
    return res.status(201).json(row);
  } catch (err) {
    return badRequest(res, err);
  }
});

// PUT /api/lawnmower (ADMIN) — update base record
mowersRouter.put('/lawnmower', withRole(['ADMIN']), async (req, res) => {
  try {
    const body = req.body || {};
    const id = Number(body.id);
    if (!Number.isFinite(id)) return res.status(400).json({ error: 'INVALID_ID' });

    const fields: Record<string, any> = {};
    const maybe = (k: string, v: any) => { if (v !== undefined) fields[k] = v; };
    maybe('name', body.name != null ? String(body.name) : undefined);
    maybe('vendor', body.vendor != null ? String(body.vendor) : undefined);
    maybe('model', body.model != null ? String(body.model) : undefined);
    maybe('serial_number', body.serial_number != null ? String(body.serial_number) : undefined);
    maybe('firmware', body.firmware != null ? String(body.firmware) : undefined);
    if (body.home_lat !== undefined) maybe('home_lat', body.home_lat != null ? Number(body.home_lat) : null);
    if (body.home_lon !== undefined) maybe('home_lon', body.home_lon != null ? Number(body.home_lon) : null);

    if (Object.keys(fields).length === 0) {
      return res.status(400).json({ error: 'VALIDATION', message: 'no fields to update' });
    }

    const sets = Object.keys(fields).map(k => `${k} = ?`).join(', ');
    const args = [...Object.values(fields), id];

    const db = getDB();
    const up = await db.prepare(`UPDATE mower SET ${sets} WHERE id = ?`).run(...args);
    if (!up.changes) return res.status(404).json({ error: 'NOT_FOUND' });

    const row = await db.prepare(
      `SELECT mower_id AS id,
              name, vendor, model, serial_number, firmware, home_lat, home_lon,
              currentState, currentBatteryLevel, currentLatitude, currentLongitude, currentTs
       FROM v_mower_current WHERE mower_id = ?`
    ).get(id);
    return res.json(row);
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
    return res.json({ ok: true });
  } catch (err) {
    return badRequest(res, err);
  }
});

