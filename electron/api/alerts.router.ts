import express from 'express';
import { getDB } from '../db';
import { requireRole } from '../ipc/auth';

export const alertsRouter = express.Router();

function extractToken(req: express.Request): string | undefined {
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

// GET /api/lawnmower/:id/alerts?openOnly=1
alertsRouter.get('/lawnmower/:id/alerts', withRole(['ADMIN', 'OPERATOR']), async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isFinite(id) || id <= 0) return res.status(400).json({ error: 'INVALID_ID' });
    const db = getDB();
    const exists = await db.prepare('SELECT id FROM mower WHERE id = ?').get(id);
    if (!exists) return res.status(404).json({ error: 'NOT_FOUND' });

    const openOnly = String(req.query.openOnly || '').trim() === '1';
    const where: string[] = ['mower_id = ?'];
    const args: any[] = [id];
    if (openOnly) where.push('ts_close IS NULL');
    const sql = `SELECT id, ts_open, ts_close, type, details FROM mower_alert WHERE ${where.join(' AND ')} ORDER BY ts_open DESC`;
    const rows = await db.prepare(sql).all(...args);
    return res.json(rows);
  } catch (e: any) {
    const code = e?.code ?? e?.errno ?? 'DB_ERROR';
    const message = e?.sqlMessage || e?.message || 'DB_ERROR';
    return res.status(500).json({ error: 'INTERNAL', code, message });
  }
});

// POST /api/lawnmower/:id/alerts/:alertId/clear (ADMIN)
alertsRouter.post('/lawnmower/:id/alerts/:alertId/clear', withRole(['ADMIN']), async (req, res) => {
  try {
    const id = Number(req.params.id);
    const alertId = Number(req.params.alertId);
    if (!Number.isFinite(id) || id <= 0 || !Number.isFinite(alertId) || alertId <= 0) {
      return res.status(400).json({ error: 'INVALID_ID' });
    }
    const db = getDB();
    const exists = await db.prepare('SELECT id FROM mower WHERE id = ?').get(id);
    if (!exists) return res.status(404).json({ error: 'NOT_FOUND' });

    const r = await db.prepare('UPDATE mower_alert SET ts_close = ? WHERE id = ? AND mower_id = ? AND ts_close IS NULL')
      .run(new Date(), alertId, id);
    if (!r.changes) return res.status(404).json({ error: 'NOT_FOUND' });
    return res.json({ ok: true });
  } catch (e: any) {
    const code = e?.code ?? e?.errno ?? 'DB_ERROR';
    const message = e?.sqlMessage || e?.message || 'DB_ERROR';
    return res.status(500).json({ error: 'INTERNAL', code, message });
  }
});

