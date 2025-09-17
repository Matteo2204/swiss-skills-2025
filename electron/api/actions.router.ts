import express from 'express';
import { getDB } from '../db';
import { requireRole } from '../ipc/auth';
import { tcpManager } from '../main/tcp/manager';
import { logger } from '../main/log/logger';

export const actionsRouter = express.Router();

function extractToken(req: express.Request): string | undefined {
  const h = req.header('authorization') || req.header('Authorization');
  if (h && /^Bearer\s+/i.test(h)) return h.replace(/^Bearer\s+/i, '').trim();
  const x = req.header('x-auth-token') || req.header('X-Auth-Token');
  if (x) return x.trim();
  const q = (req.query?.token as string | undefined)?.trim();
  return q || undefined;
}

function withAdmin() {
  return async (req: express.Request, res: express.Response, next: express.NextFunction) => {
    try {
      const token = extractToken(req);
      const s = await requireRole(token, ['ADMIN']);
      (req as any).auth = s; // { user_id, role }
      return next();
    } catch (e: any) {
      const msg = String(e?.message || e || 'UNAUTHORIZED');
      if (msg === 'FORBIDDEN') return res.status(403).json({ error: 'FORBIDDEN' });
      return res.status(401).json({ error: 'UNAUTHORIZED' });
    }
  };
}

const ALLOWED = new Set(['start', 'stop', 'home', 'ackerror']);

actionsRouter.post('/lawnmower/:id/actions/:action', withAdmin(), async (req, res) => {
  try {
    const db = getDB();
    const id = Number(req.params.id);
    if (!Number.isFinite(id) || id <= 0) return res.status(404).json({ error: 'NOT_FOUND' });
    const exists = await db.prepare('SELECT id FROM mower WHERE id = ?').get(id);
    if (!exists) return res.status(404).json({ error: 'NOT_FOUND' });

    const action = String(req.params.action || '').toLowerCase();
    if (!ALLOWED.has(action)) return res.status(400).json({ error: 'INVALID_ACTION' });

    // Resolve client by mowerId via manager
    const entry = tcpManager.getClientByMowerId(id);
    if (!entry) {
      // Manager not active or client missing
      await db.prepare('INSERT INTO mower_action (mower_id, ts, action, outcome, iin, port) VALUES (?,?,?,?,?,?)')
        .run(id, new Date(), action, 'error', null, null);
      return res.status(503).json({ status: 'no_connection', iin: null });
    }

    const { client, port } = entry;
    // Peek IIN for logging "queued"; send in background
    const nextIIN = client.peekNextIIN();
    const ins = await db.prepare('INSERT INTO mower_action (mower_id, ts, action, outcome, iin, port) VALUES (?,?,?,?,?,?)')
      .run(id, new Date(), action, 'queued', nextIIN, port);
    const actionId = Number(ins.lastInsertRowid);

    // Audit log: queued
    try {
      const userId = Number((req as any).auth?.user_id || 0) || undefined;
      logger.info('action_queued', { iin: nextIIN, port, mower_id: id, ctx: { userId, action } });
    } catch {}

    // Map action to (type, body)
    let type = 0x01; let body = new Uint8Array(0);
    if (action === 'start') body = new Uint8Array([0x01]);
    else if (action === 'stop') body = new Uint8Array([0x00]);
    else if (action === 'home') body = new Uint8Array([0x02]);
    else if (action === 'ackerror') { type = 0x02; body = new Uint8Array(0); }

    const ackP = client.send(type, body, true);

    // Wait up to 500ms for ack, else 202 queued; also update outcome later when ack arrives
    let responded = false;
    const timer = setTimeout(() => {
      if (!responded) {
        responded = true;
        res.status(202).json({ status: 'queued', iin: nextIIN });
      }
    }, 500);

    ackP.then(async (r) => {
      clearTimeout(timer);
      const outcome = r.ok ? 'ack' : 'error';
      try { await db.prepare('UPDATE mower_action SET outcome=? WHERE id=?').run(outcome, actionId); } catch {}
      try {
        const userId = Number((req as any).auth?.user_id || 0) || undefined;
        logger.info('action_result', { iin: r.iin, port, mower_id: id, ctx: { userId, action, outcome } });
      } catch {}
      if (!responded) {
        responded = true;
        res.status(200).json({ status: outcome, iin: r.iin });
      }
    }).catch(async (_e) => {
      clearTimeout(timer);
      try { await db.prepare('UPDATE mower_action SET outcome=? WHERE id=?').run('error', actionId); } catch {}
      try {
        const userId = Number((req as any).auth?.user_id || 0) || undefined;
        logger.error('action_result', { iin: nextIIN, port, mower_id: id, ctx: { userId, action, outcome: 'timeout' } });
      } catch {}
      if (!responded) {
        responded = true;
        res.status(504).json({ status: 'timeout', iin: nextIIN });
      }
    });
  } catch (err: any) {
    const code = err?.code ?? err?.errno ?? 'DB_ERROR';
    const message = err?.sqlMessage || err?.message || 'DB_ERROR';
    return res.status(500).json({ error: 'INTERNAL', code, message });
  }
});
