// electron/server.ts
import express from "express";
import path from "path";
import fs from "fs";
import type { Server } from "http";
import { getDB } from "./db";
import { mowersRouter } from "./api/mowers.router";
import { actionsRouter } from "./api/actions.router";
import { alertsRouter } from "./api/alerts.router";
import { verifyPassword } from "./db/utils";
import crypto from "crypto";

// (opzionale ma utile) cattura rejection per log leggibili in packaged
process.on("unhandledRejection", (err) => {
    console.error("[server] unhandledRejection:", err);
});

async function listen(app: express.Express, port: number): Promise<Server> {
    return await new Promise<Server>((resolve, reject) => {
        const srv = app
            .listen(port, "127.0.0.1")
            .once("listening", () => resolve(srv))
            .once("error", (err: any) => reject(err));
    });
}

export async function createExpressServer(
    staticRoot: string,
    preferredPort = 3000
): Promise<{ url: string; server: Server }> {
    const app = express();

    // --- Helpers (local, minimal surface) ---
    const db = () => getDB();

    function toMySqlDateTime(d: Date): string {
        const pad = (n: number, w = 2) => n.toString().padStart(w, "0");
        const Y = d.getUTCFullYear();
        const M = pad(d.getUTCMonth() + 1);
        const D = pad(d.getUTCDate());
        const h = pad(d.getUTCHours());
        const m = pad(d.getUTCMinutes());
        const s = pad(d.getUTCSeconds());
        const ms = d.getUTCMilliseconds();
        const ms3 = ms.toString().padStart(3, "0");
        return `${Y}-${M}-${D} ${h}:${m}:${s}.${ms3}`;
    }

    function parseDateStrict(input: string): Date | null {
        if (!input) return null;
        const s = String(input).trim();
        if (/^\d+$/.test(s)) {
            const num = Number(s);
            const ms = s.length >= 12 ? num : num * 1000; // assume seconds if short
            const d = new Date(ms);
            return isNaN(d.getTime()) ? null : d;
        }
        const d = new Date(s);
        return isNaN(d.getTime()) ? null : d;
    }

    async function ensureMowerExistsSimple(mowerId: number): Promise<boolean> {
        const row = await db().prepare("SELECT id FROM mower WHERE id = ?").get(mowerId);
        return !!row;
    }

    function parseId(raw: string | undefined): number | null {
        if (!raw) return null;
        const n = Number(raw);
        if (!Number.isFinite(n)) return null;
        const i = Math.floor(n);
        return i > 0 ? i : null;
    }

    // Parse JSON payloads for REST API
    app.use(express.json());

    // CSP semplice (serve consentire inline handler Angular per <link onload>)
    const csp = [
        "default-src 'self'",
        "script-src 'self' 'unsafe-inline'",
        "style-src 'self' 'unsafe-inline'",
        "img-src 'self' data: blob:",
        "font-src 'self' data:",
        "connect-src 'self'",
        "media-src 'self'",
        "object-src 'none'",
        "frame-ancestors 'none'",
        "base-uri 'self'",
        "form-action 'self'",
    ].join("; ");
    app.use((_, res, next) => {
        res.setHeader("Content-Security-Policy", csp);
        next();
    });

    console.log("[server] static root:", staticRoot);

    // --- Auth (minimal REST endpoint for tooling) ---
    // Assunzione: manca un endpoint REST di login; aggiungo POST /api/auth/login che replica la logica IPC.
    app.post('/api/auth/login', async (req, res) => {
        try {
            const { username, password, remember } = req.body || {};
            const u = typeof username === 'string' ? username.trim() : '';
            const p = typeof password === 'string' ? password : '';
            if (!u || !p) return res.status(400).json({ ok: false, error: 'INVALID_INPUT' });

            const row = await getDB()
                .prepare('SELECT id, username, password_hash, role FROM users WHERE username = ?')
                .get(u) as { id: number; username: string; password_hash: string; role: 'ADMIN' | 'OPERATOR' } | undefined;
            if (!row) return res.status(401).json({ ok: false, error: 'INVALID_CREDENTIALS' });

            const ok = await verifyPassword(row.password_hash, p);
            if (!ok) return res.status(401).json({ ok: false, error: 'INVALID_CREDENTIALS' });

            const token = crypto.randomBytes(24).toString('base64url');
            try {
                await getDB().prepare('INSERT INTO sessions (token, user_id, role, remember) VALUES (?,?,?,?)')
                    .run(token, row.id, row.role, remember ? 1 : 0);
            } catch { /* non-fatal */ }

            return res.json({ ok: true, token, user: { id: row.id, username: row.username, role: row.role } });
        } catch (e) {
            console.error('[api auth:login] error', e);
            return res.status(500).json({ ok: false, error: 'SERVER_ERROR' });
        }
    });

    // === Minimal API: LawnMower analytics ===
    // Note: endpoints available only when packaged (this server serves the UI).
    // Assunzioni minime:
    // - query range accetta ISO8601 o millis epoch; se assente, usa i limiti del dataset.
    // - per efficiency ignoriamo solo lo stato 'StationChargingCompleted' come attesa post-carica.

    // Helpers
    function parseDate(q?: any): Date | undefined {
        if (!q) return undefined;
        const s = String(q);
        if (!s) return undefined;
        const n = Number(s);
        const d = Number.isFinite(n) && s.trim() !== '' && /^(\d{10}|\d{13})$/.test(s)
            ? new Date(s.length === 10 ? n * 1000 : n)
            : new Date(s);
        return isNaN(d.getTime()) ? undefined : d;
    }
    function badRange(res: express.Response) {
        res.status(400).json({ error: 'INVALID_RANGE' });
    }
    async function ensureMower(id: number): Promise<boolean> {
        const row = await getDB().prepare('SELECT 1 AS ok FROM mower WHERE id = ?').get(id) as { ok: number } | undefined;
        return !!row;
    }
    function toMysqlDate(d: Date): string { // format YYYY-MM-DD HH:MM:SS.mmm
        const pad = (n: number, w = 2) => n.toString().padStart(w, '0');
        return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(),3)}`;
    }
    const R = 6371000; // meters
    const toRad = (deg: number) => (deg * Math.PI) / 180;

    // GET /api/lawnmower/:id/analytics/distance
    app.get('/api/lawnmower/:id/analytics/distance', async (req, res) => {
        try {
            const id = Number(req.params.id);
            if (!Number.isFinite(id) || id <= 0) return res.status(400).json({ error: 'INVALID_ID' });
            if (!(await ensureMower(id))) return res.status(404).json({ error: 'NOT_FOUND' });

            const from = parseDate(req.query.from);
            const to = parseDate(req.query.to);
            if (from && to && from.getTime() > to.getTime()) return badRange(res);

            const where: string[] = ['mower_id = ?'];
            const params: any[] = [id];
            if (from) { where.push('ts >= ?'); params.push(toMysqlDate(from)); }
            if (to)   { where.push('ts <= ?'); params.push(toMysqlDate(to)); }
            const sql = `SELECT ts, lat, lon FROM mower_gps WHERE ${where.join(' AND ')} ORDER BY ts ASC`;
            const rows = await getDB().prepare(sql).all(...params) as Array<{ ts: Date|string; lat: any; lon: any }>;

            let meters = 0;
            for (let i = 1; i < rows.length; i++) {
                const a = rows[i-1], b = rows[i];
                const lat1 = Number(a.lat), lon1 = Number(a.lon);
                const lat2 = Number(b.lat), lon2 = Number(b.lon);
                if (!isFinite(lat1) || !isFinite(lon1) || !isFinite(lat2) || !isFinite(lon2)) continue;
                const dLat = toRad(lat2 - lat1), dLon = toRad(lon2 - lon1);
                const la1 = toRad(lat1), la2 = toRad(lat2);
                const h = Math.sin(dLat/2)**2 + Math.cos(la1) * Math.cos(la2) * Math.sin(dLon/2)**2;
                const d = 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
                const ta = new Date(a.ts as any).getTime();
                const tb = new Date(b.ts as any).getTime();
                const dtMin = (tb - ta) / 60000;
                if (dtMin <= 0) continue;
                // outlier filter: >500 m/min
                if (d / dtMin > 500) continue;
                meters += d;
            }
            const m = Math.round(meters);
            // Keep existing 'meters' for backward compat; add spec key
            res.json({ meters: m, totalDistance: m });
        } catch (e) {
            console.error('[api distance] error', e);
            res.status(500).json({ error: 'SERVER_ERROR' });
        }
    });

    // GET /api/lawnmower/:id/analytics/hours
    app.get('/api/lawnmower/:id/analytics/hours', async (req, res) => {
        try {
            const id = Number(req.params.id);
            if (!Number.isFinite(id) || id <= 0) return res.status(400).json({ error: 'INVALID_ID' });
            if (!(await ensureMower(id))) return res.status(404).json({ error: 'NOT_FOUND' });

            const from = parseDate(req.query.from);
            const to = parseDate(req.query.to);
            if (from && to && from.getTime() > to.getTime()) return badRange(res);

            const db = getDB();
            let points: Array<{ ts: Date; state: string }> = [];
            if (from) {
                const prev = await db
                    .prepare('SELECT ts, state FROM mower_state WHERE mower_id = ? AND ts < ? ORDER BY ts DESC LIMIT 1')
                    .get(id, toMysqlDate(from)) as { ts: Date; state: string } | undefined;
                if (prev) points.push({ ts: new Date(from), state: prev.state });
            }
            const where: string[] = ['mower_id = ?'];
            const params: any[] = [id];
            if (from) { where.push('ts >= ?'); params.push(toMysqlDate(from)); }
            if (to)   { where.push('ts <= ?'); params.push(toMysqlDate(to)); }
            const sql = `SELECT ts, state FROM mower_state WHERE ${where.join(' AND ')} ORDER BY ts ASC`;
            const rows = await db.prepare(sql).all(...params) as Array<{ ts: any; state: string }>;
            for (const r of rows) points.push({ ts: new Date(r.ts), state: r.state });
            if (points.length === 0) return res.json({ hours: 0 });

            const endTs = to ?? points[points.length - 1].ts;
            let mowingMs = 0;
            for (let i = 0; i < points.length; i++) {
                const cur = points[i];
                const nextTs = i + 1 < points.length ? points[i+1].ts : endTs;
                const dt = nextTs.getTime() - cur.ts.getTime();
                if (dt <= 0) continue;
                if (cur.state === 'Mowing') mowingMs += dt;
            }
            const hours = Math.round((mowingMs / 3600000) * 100) / 100;
            res.json({ hours, operationalHours: hours });
        } catch (e) {
            console.error('[api hours] error', e);
            res.status(500).json({ error: 'SERVER_ERROR' });
        }
    });

    // GET /api/lawnmower/:id/analytics/efficiency
    app.get('/api/lawnmower/:id/analytics/efficiency', async (req, res) => {
        try {
            const id = Number(req.params.id);
            if (!Number.isFinite(id) || id <= 0) return res.status(400).json({ error: 'INVALID_ID' });
            if (!(await ensureMower(id))) return res.status(404).json({ error: 'NOT_FOUND' });

            const from = parseDate(req.query.from);
            const to = parseDate(req.query.to);
            if (from && to && from.getTime() > to.getTime()) return badRange(res);

            const db = getDB();
            let points: Array<{ ts: Date; state: string }> = [];
            if (from) {
                const prev = await db
                    .prepare('SELECT ts, state FROM mower_state WHERE mower_id = ? AND ts < ? ORDER BY ts DESC LIMIT 1')
                    .get(id, toMysqlDate(from)) as { ts: Date; state: string } | undefined;
                if (prev) points.push({ ts: new Date(from), state: prev.state });
            }
            const where: string[] = ['mower_id = ?'];
            const params: any[] = [id];
            if (from) { where.push('ts >= ?'); params.push(toMysqlDate(from)); }
            if (to)   { where.push('ts <= ?'); params.push(toMysqlDate(to)); }
            const sql = `SELECT ts, state FROM mower_state WHERE ${where.join(' AND ')} ORDER BY ts ASC`;
            const rows = await db.prepare(sql).all(...params) as Array<{ ts: any; state: string }>;
            for (const r of rows) points.push({ ts: new Date(r.ts), state: r.state });
            if (points.length === 0) return res.json({ byState: {} });
            const endTs = to ?? points[points.length - 1].ts;
            const durations = new Map<string, number>();
            let total = 0;
            for (let i = 0; i < points.length; i++) {
                const cur = points[i];
                const nextTs = i + 1 < points.length ? points[i+1].ts : endTs;
                const dt = nextTs.getTime() - cur.ts.getTime();
                if (dt <= 0) continue;
                if (cur.state === 'StationChargingCompleted') continue; // ignora attesa post-carica (assunzione)
                durations.set(cur.state, (durations.get(cur.state) ?? 0) + dt);
                total += dt;
            }
            const h = (ms: number) => Math.round((ms / 3600000) * 10) / 10;
            const timeMowing = h(durations.get('Mowing') ?? 0);
            const timeReturningToStation = h(durations.get('Docking') ?? 0);
            const timeError = h(durations.get('Stuck') ?? 0);
            // Not explicitly tracked in our state model; default to 0 unless present
            const timePaused = h(durations.get('Paused') ?? 0);
            const timeCharging = h(durations.get('Charging') ?? 0);
            const denom = (timeMowing + timePaused + timeError + timeCharging + timeReturningToStation);
            const efficiencyPercentage = denom > 0 ? Math.round((timeMowing / denom) * 1000) / 10 : 0;
            res.json({ timeMowing, timePaused, timeError, timeCharging, timeReturningToStation, efficiencyPercentage });
        } catch (e) {
            console.error('[api efficiency] error', e);
            res.status(500).json({ error: 'SERVER_ERROR' });
        }
    });

    // Spec typo alias: /analytics/efficency -> redirect to /analytics/efficiency (preserve query)
    app.get('/api/lawnmower/:id/analytics/efficency', (req, res) => {
        try {
            const id = encodeURIComponent(String(req.params.id));
            const q = req.url.includes('?') ? ('?' + req.url.split('?')[1]) : '';
            res.redirect(307, `/api/lawnmower/${id}/analytics/efficiency${q}`);
        } catch {
            res.redirect(307, `/api/lawnmower/${req.params.id}/analytics/efficiency`);
        }
    });

    // GET /api/lawnmower/:id/analytics/energy
    app.get('/api/lawnmower/:id/analytics/energy', async (req, res) => {
        try {
            const id = Number(req.params.id);
            if (!Number.isFinite(id) || id <= 0) return res.status(400).json({ error: 'INVALID_ID' });
            if (!(await ensureMower(id))) return res.status(404).json({ error: 'NOT_FOUND' });

            const from = parseDate(req.query.from);
            const to = parseDate(req.query.to);
            if (from && to && from.getTime() > to.getTime()) return badRange(res);

            const where: string[] = ['mower_id = ?'];
            const params: any[] = [id];
            if (from) { where.push('ts >= ?'); params.push(toMysqlDate(from)); }
            if (to)   { where.push('ts <= ?'); params.push(toMysqlDate(to)); }
            const sql = `SELECT ts, level FROM mower_battery WHERE ${where.join(' AND ')} ORDER BY ts ASC`;
            const rows = await getDB().prepare(sql).all(...params) as Array<{ ts: any; level: any }>;
            if (rows.length === 0) return res.json({ chargeCycles: 0, avgChargeMinutes: 0, maxLevel: 0, minLevel: 0, decayPerHour: 0 });

            const series = rows.map(r => ({ ts: new Date(r.ts), level: Number(r.level) }));
            let minLevel = Infinity, maxLevel = -Infinity;
            for (const p of series) { if (p.level < minLevel) minLevel = p.level; if (p.level > maxLevel) maxLevel = p.level; }

            // detect charge cycles: sustained increase segments (>=10% and >=10 minutes)
            type Cycle = { startTs: Date; endTs: Date };
            const cycles: Cycle[] = [];
            let startIdx: number | null = null;
            for (let i = 1; i < series.length; i++) {
                const prev = series[i-1], cur = series[i];
                if (cur.level > prev.level + 0.1) {
                    if (startIdx === null) startIdx = i - 1;
                } else {
                    if (startIdx !== null) {
                        const st = series[startIdx], en = series[i-1];
                        const delta = en.level - st.level;
                        const minutes = (en.ts.getTime() - st.ts.getTime()) / 60000;
                        if (delta >= 10 && minutes >= 10) cycles.push({ startTs: st.ts, endTs: en.ts });
                        startIdx = null;
                    }
                }
            }
            if (startIdx !== null) {
                const st = series[startIdx], en = series[series.length - 1];
                const delta = en.level - st.level;
                const minutes = (en.ts.getTime() - st.ts.getTime()) / 60000;
                if (delta >= 10 && minutes >= 10) cycles.push({ startTs: st.ts, endTs: en.ts });
            }

            const chargeCycles = cycles.length;
            let avgChargeMinutes = 0;
            if (chargeCycles > 0) {
                const sum = cycles.reduce((acc, c) => acc + (c.endTs.getTime() - c.startTs.getTime()) / 60000, 0);
                avgChargeMinutes = Math.round(sum / chargeCycles);
            }

            // decay per hour outside charging segments
            const withinCycle = (ts: Date) => cycles.some(c => ts >= c.startTs && ts <= c.endTs);
            let totalHours = 0;
            let totalDecay = 0; // percentage points
            for (let i = 1; i < series.length; i++) {
                const a = series[i-1], b = series[i];
                const midInCycle = withinCycle(a.ts) || withinCycle(b.ts);
                if (midInCycle) continue; // skip charging
                const dtH = (b.ts.getTime() - a.ts.getTime()) / 3600000;
                if (dtH <= 0) continue;
                const delta = b.level - a.level;
                if (delta < 0) {
                    totalDecay += -delta; // positive points
                    totalHours += dtH;
                }
            }
            const decayPerHour = totalHours > 0 ? Math.round((totalDecay / totalHours) * 10) / 10 : 0;

            const maxLvl = Number.isFinite(maxLevel) ? Math.round(maxLevel) : 0;
            const minLvl = Number.isFinite(minLevel) ? Math.round(minLevel) : 0;
            // Keep old keys and add spec-compliant aliases
            res.json({
                chargeCycles,
                avgChargeMinutes, // legacy key (minutes)
                maxLevel: maxLvl, // legacy key
                minLevel: minLvl, // legacy key
                decayPerHour,     // legacy key (percentage points/hour)
                averageRechargeTime: avgChargeMinutes,
                maxBatteryLevel: maxLvl,
                minBatteryLevel: minLvl,
                avgBatteryLost: decayPerHour,
            });
        } catch (e) {
            console.error('[api energy] error', e);
            res.status(500).json({ error: 'SERVER_ERROR' });
        }
    });

    // --- API routes (placed before SPA fallback) ---
    // Assunzione: se il mower esiste ma non ha telemetria, ritorniamo 200 {} (no 404).
    // Default range: ultimi 7 giorni. Se solo 'from' presente → to=now; se solo 'to' presente → from=to-7d.
    app.get("/api/lawnmower/:id/:kind/current", async (req, res) => {
        try {
            const mowerId = parseId(req.params.id);
            if (!mowerId) return res.status(404).json({ error: "mower not found" });
            if (!(await ensureMowerExistsSimple(mowerId))) return res.status(404).json({ error: "mower not found" });

            const kind = req.params.kind as "battery" | "gps" | "state";
            if (kind !== 'battery' && kind !== 'gps' && kind !== 'state') {
                return res.status(400).json({ error: 'invalid kind' });
            }
            const viewMap = {
                battery: { view: "v_mower_latest_battery", cols: "ts, level" },
                gps: { view: "v_mower_latest_gps", cols: "ts, lat, lon" },
                state: { view: "v_mower_latest_state", cols: "ts, state" },
            } as const;
            const v = viewMap[kind];
            const row = await db().prepare(`SELECT ${v.cols} FROM ${v.view} WHERE mower_id = ?`).get(mowerId);
            if (!row) return res.json({});
            // Ensure compact payload
            if (kind === "battery") {
                const level = Number(row.level);
                const payload = { ts: row.ts, level } as any;
                // Spec aliases
                (payload as any).timestamp = row.ts;
                (payload as any).batteryLevel = level;
                return res.json(payload);
            }
            if (kind === "gps") {
                const lat = Number(row.lat), lon = Number(row.lon);
                const payload = { ts: row.ts, lat, lon } as any;
                // Spec aliases
                (payload as any).timestamp = row.ts;
                (payload as any).latitude = lat;
                (payload as any).longitude = lon;
                return res.json(payload);
            }
            const payload = { ts: row.ts, state: String(row.state) } as any;
            (payload as any).timestamp = row.ts;
            return res.json(payload);
        } catch (e: any) {
            console.error("[api] current error:", e);
            return res.status(500).json({ error: "internal error" });
        }
    });

    app.get("/api/lawnmower/:id/:kind/history", async (req, res) => {
        try {
            const mowerId = parseId(req.params.id);
            if (!mowerId) return res.status(404).json({ error: "mower not found" });
            if (!(await ensureMowerExistsSimple(mowerId))) return res.status(404).json({ error: "mower not found" });

            const now = new Date();
            const qFrom = typeof req.query.from === "string" ? req.query.from : undefined;
            const qTo = typeof req.query.to === "string" ? req.query.to : undefined;
            let dTo = qTo ? parseDateStrict(qTo) : now;
            if (!dTo) return res.status(400).json({ error: "invalid 'to'" });
            let dFrom = qFrom ? parseDateStrict(qFrom) : new Date(dTo.getTime() - 7 * 24 * 3600 * 1000);
            if (!dFrom) return res.status(400).json({ error: "invalid 'from'" });
            if (dFrom.getTime() > dTo.getTime()) return res.status(400).json({ error: "from must be <= to" });

            const fromStr = toMySqlDateTime(dFrom);
            const toStr = toMySqlDateTime(dTo);

            const limit = req.query.limit != null ? Math.max(0, Math.floor(Number(req.query.limit))) : undefined;
            const offset = req.query.offset != null ? Math.max(0, Math.floor(Number(req.query.offset))) : 0;

            const kind = req.params.kind as "battery" | "gps" | "state";
            if (kind !== 'battery' && kind !== 'gps' && kind !== 'state') {
                return res.status(400).json({ error: 'invalid kind' });
            }
            const tblMap = {
                battery: { table: "mower_battery", cols: "ts, level" },
                gps: { table: "mower_gps", cols: "ts, lat, lon" },
                state: { table: "mower_state", cols: "ts, state" },
            } as const;
            const t = tblMap[kind];

            let sql = `SELECT ${t.cols} FROM ${t.table} WHERE mower_id = ? AND ts >= ? AND ts <= ? ORDER BY ts ASC`;
            const args: any[] = [mowerId, fromStr, toStr];
            if (limit !== undefined) {
                sql += " LIMIT ? OFFSET ?";
                args.push(limit, offset);
            }

            const rows = await db().prepare(sql).all(...args);
            if (kind === "battery") {
                return res.json(rows.map((r: any) => ({
                    ts: r.ts,
                    level: Number(r.level),
                    timestamp: r.ts,
                    batteryLevel: Number(r.level),
                })));
            } else if (kind === "gps") {
                return res.json(rows.map((r: any) => ({
                    ts: r.ts,
                    lat: Number(r.lat),
                    lon: Number(r.lon),
                    timestamp: r.ts,
                    latitude: Number(r.lat),
                    longitude: Number(r.lon),
                })));
            } else {
                return res.json(rows.map((r: any) => ({
                    ts: r.ts,
                    state: String(r.state),
                    timestamp: r.ts,
                })));
            }
        } catch (e: any) {
            console.error("[api] history error:", e);
            return res.status(500).json({ error: "internal error" });
        }
    });

    // API routes (register before SPA fallback)
    app.use('/api', mowersRouter);
    app.use('/api', actionsRouter);
    app.use('/api', alertsRouter);

    // Statici (niente index auto) — registra solo se la UI esiste
    const hasUi = (() => {
        try {
            return fs.existsSync(staticRoot) && fs.existsSync(path.join(staticRoot, 'index.html'));
        } catch { return false; }
    })();
    if (hasUi) {
        app.use(
            express.static(staticRoot, {
                extensions: ["html"],
                index: false,
                etag: false,
                maxAge: 0,
            })
        );

        // Route esplicita per "/"
        app.get("/", (_req, res) => res.sendFile(path.join(staticRoot, "index.html")));

        // ✅ Express 5: usare **RegExp** per il fallback, NON "*" e NON "(.*)"
        app.get(/.*/, (_req, res) => res.sendFile(path.join(staticRoot, "index.html")));
    } else {
        console.warn('[server] UI static root not found; serving API only. Root:', staticRoot);
    }

    // Avvio con fallback porta
    let server: Server;
    try {
        server = await listen(app, preferredPort);
        console.log(`[server] Express listening on http://127.0.0.1:${preferredPort} (root: ${staticRoot})`);
    } catch (err: any) {
        console.warn(`[server] Port ${preferredPort} busy (${err?.code}). Falling back to random port.`);
        server = await listen(app, 0);
        const addr = server.address();
        const p = typeof addr === "object" && addr ? addr.port : 0;
        console.log(`[server] Express listening on http://127.0.0.1:${p} (root: ${staticRoot})`);
    }

    const addr = server.address();
    const port = typeof addr === "object" && addr ? addr.port : preferredPort;
    const url = `http://127.0.0.1:${port}`;
    return { url, server };
}
