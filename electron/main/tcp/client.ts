import net from 'node:net';
import { encode, decode } from '../protocol/frame';
import { Session } from '../protocol/session';
import { getDB } from '../../db';
import { logger } from '../log/logger';

type Pending = {
  resolve: (v: { ok: boolean; code?: number; data?: Uint8Array; iin: number }) => void;
  reject: (err: any) => void;
  timer: NodeJS.Timeout;
  tries: number;
  type: number;
  body: Uint8Array;
};

export type ClientOptions = {
  host?: string;
  connTimeoutMs?: number; // default 2000
  inFrameTimeoutMs?: number; // default 200
  responseTimeoutMs?: number; // default 500
  heartbeatMs?: number; // default 15000
};

export class TcpClient {
  private readonly host: string;
  private readonly port: number;
  private readonly mowerId: number;
  private readonly connTimeoutMs: number;
  private readonly inFrameTimeoutMs: number;
  private readonly responseTimeoutMs: number;
  private readonly heartbeatMs: number;

  private sock: net.Socket | null = null;
  private session: Session | null = null;
  private connected = false;
  private handshakeDone = false;
  private rxRest: Uint8Array = new Uint8Array(0);
  private rxTimer: NodeJS.Timeout | null = null;
  private hbTimer: NodeJS.Timeout | null = null;
  private backoffIdx = 0;
  private iin = 0;
  private pendings: Map<number, Pending> = new Map();

  constructor(port: number, mowerId: number, opts: ClientOptions = {}) {
    this.host = opts.host ?? '127.0.0.1';
    this.port = port;
    this.mowerId = mowerId;
    this.connTimeoutMs = opts.connTimeoutMs ?? 2000;
    this.inFrameTimeoutMs = opts.inFrameTimeoutMs ?? 200;
    this.responseTimeoutMs = opts.responseTimeoutMs ?? 500;
    this.heartbeatMs = opts.heartbeatMs ?? 15000;
  }

  start() {
    this.connect();
  }

  stop() {
    this.clearHb();
    this.clearRxTimer();
    if (this.sock) {
      try { this.sock.destroy(); } catch {}
    }
    this.sock = null;
    this.connected = false;
    this.handshakeDone = false;
  }

  peekNextIIN(): number { return ((this.iin + 1) & 0xff) >>> 0; }

  async send(type: number, body: Uint8Array, expectAck = true): Promise<{ ok: boolean; code?: number; data?: Uint8Array; iin: number }> {
    if (!this.connected || !this.handshakeDone || !this.session) throw new Error('not connected');
    const { txKey } = this.session.deriveKeys();
    const iin = (this.iin = (this.iin + 1) & 0xff);
    const payloadNoMac = new Uint8Array(2 + body.length);
    payloadNoMac[0] = type;
    payloadNoMac[1] = iin;
    payloadNoMac.set(body, 2);
    const mac = this.session.calcMAC(payloadNoMac.subarray(1), txKey); // exclude type
    const macBytes = u32be(mac);
    const payload = new Uint8Array(payloadNoMac.length + 4);
    payload.set(payloadNoMac);
    payload.set(macBytes, payloadNoMac.length);
    const frame = encode(payload);
    this.sock!.write(frame);
    try { logger.info('tx', { iin, port: this.port, mower_id: this.mowerId, ctx: { type } }); } catch {}

    if (!expectAck) return { ok: true, iin } as any;

    return await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.handleResponseTimeout(iin);
      }, this.responseTimeoutMs);
      this.pendings.set(iin, { resolve, reject, timer, tries: 1, type, body });
    });
  }

  private connect() {
    const sock = net.createConnection({ host: this.host, port: this.port });
    this.sock = sock;
    sock.setNoDelay(true);
    sock.setTimeout(this.connTimeoutMs, () => {
      this.log('timeout', `conn timeout ${this.connTimeoutMs}ms`);
      sock.destroy(new Error('connect timeout'));
    });
    sock.once('connect', () => {
      this.connected = true;
      this.log('connect', '');
      sock.setTimeout(0);
      this.beginHandshake();
    });
    sock.on('error', (err) => {
      this.log('disconnect', `error: ${(err as Error).message}`);
    });
    sock.on('close', () => {
      this.connected = false;
      this.handshakeDone = false;
      this.clearHb();
      this.clearRxTimer();
      this.scheduleReconnect();
    });
    sock.on('data', (chunk) => this.onData(chunk));
  }

  private scheduleReconnect() {
    const delays = [1000, 2000, 5000, 10000, 30000];
    const d = delays[Math.min(this.backoffIdx, delays.length - 1)];
    this.backoffIdx = Math.min(this.backoffIdx + 1, delays.length - 1);
    this.log('retry', `in ${d}ms`);
    setTimeout(() => this.connect(), d);
  }

  private beginHandshake() {
    this.session = new Session();
    try {
      const hello = this.session.beginHandshake();
      // Assunzione: handshake non incapsulato in frame; invio raw public key
      this.sock!.write(hello);
    } catch (e) {
      this.log('auth_fail', (e as Error).message);
      this.sock?.destroy();
    }
  }

  private completeHandshake(peerHello: Uint8Array) {
    if (!this.session) return;
    try {
      // Rispondiamo (loopback) con il nostro public key
      const response = this.session.acceptChallenge(peerHello);
      this.sock!.write(response);
      // KDF
      this.session.deriveKeys();
      this.handshakeDone = true;
      this.backoffIdx = 0;
      this.log('auth_ok', '');
      this.startHeartbeat();
    } catch (e) {
      this.log('auth_fail', (e as Error).message);
      this.sock?.destroy();
    }
  }

  private onData(chunk: Buffer) {
    if (!this.handshakeDone) {
      // Assunzione: peer public key è 4 byte (p=0xFFFFFFFB)
      if ((this.rxRest.length + chunk.length) < 4) {
        this.rxRest = concat(this.rxRest, chunk);
        return;
      }
      const merged = concat(this.rxRest, chunk);
      const peer = merged.subarray(0, 4);
      const rem = merged.subarray(4);
      this.rxRest = new Uint8Array(0);
      this.completeHandshake(peer);
      if (rem.length) this.onData(Buffer.from(rem));
      return;
    }

    // Framing (merge with previous rest)
    const merged = concat(this.rxRest, chunk);
    const { frames, rest } = decode(merged, undefined);
    this.rxRest = rest;
    if (this.rxRest.length) this.armRxTimer(); else this.clearRxTimer();
    for (const pl of frames) this.handlePayload(pl);
  }

  private armRxTimer() {
    this.clearRxTimer();
    this.rxTimer = setTimeout(() => {
      if (this.rxRest.length) {
        // in-frame timeout: drop partial and log
        this.rxRest = new Uint8Array(0);
        this.log('timeout', 'in-frame 200ms');
      }
    }, this.inFrameTimeoutMs);
  }

  private clearRxTimer() { if (this.rxTimer) { clearTimeout(this.rxTimer); this.rxTimer = null; } }
  private clearHb() { if (this.hbTimer) { clearInterval(this.hbTimer); this.hbTimer = null; } }

  private startHeartbeat() {
    this.clearHb();
    this.hbTimer = setInterval(() => {
      // type 0x00 heartbeat, no body, expect ack
      this.log('heartbeat', '');
      this.send(0x00, new Uint8Array(0), false).catch(() => {});
    }, this.heartbeatMs);
  }

  private handlePayload(payload: Uint8Array) {
    if (!this.session) return;
    if (payload.length < 1 + 1 + 4) return; // type + iin + mac
    const { rxKey } = this.session.deriveKeys();
    const type = payload[0];
    const iin = payload[1];
    const body = payload.subarray(2, payload.length - 4);
    const macRx = readU32BE(payload, payload.length - 4);
    const macExp = this.session.calcMAC(payload.subarray(1, payload.length - 4), rxKey);
    if ((macRx >>> 0) !== (macExp >>> 0)) {
      // drop silently (auth fail for message)
      return;
    }

    if (type === 0x02 /* ack */) {
      const code = body[0] ?? 0;
      const pending = this.pendings.get(iin);
      if (pending) {
        clearTimeout(pending.timer);
        this.pendings.delete(iin);
        pending.resolve({ ok: code === 0, code, iin });
      }
      return;
    }

    if (type === 0x80 /* status */) {
      this.ingestStatus(body);
    } else if (type === 0x81 /* position */) {
      this.ingestPosition(body);
    }
  }

  private async ingestStatus(body: Uint8Array) {
    // Assunzione: body = [battery_x2:1, blade_time_s:4 u32, state:1]
    if (body.length < 6) return;
    const batteryX2 = body[0];
    const blade = readU32BE(body, 1);
    const stateEnum = body[5];
    const battery = Number((batteryX2 / 2).toFixed(1));
    const state = this.mapStateEnum(stateEnum);
    const ts = new Date();
    const db = getDB();
    await db.prepare('INSERT INTO mower_battery (mower_id, ts, level) VALUES (?,?,?) ON DUPLICATE KEY UPDATE level=VALUES(level)')
      .run(this.mowerId, ts, battery);
    await db.prepare('INSERT INTO mower_state (mower_id, ts, state) VALUES (?,?,?) ON DUPLICATE KEY UPDATE state=VALUES(state)')
      .run(this.mowerId, ts, state);

    // BladeWorn alert: blade time cumulato oltre soglia (assunzione 50h)
    try {
      const BLADE_WORN_HOURS = 50; // soglia parametrizzata
      const hours = blade / 3600;
      if (hours >= BLADE_WORN_HOURS) {
        const details = `bladeTimeHours=${hours.toFixed(1)}`;
        await this.openOrUpdateAlert('BladeWorn', details);
      }
    } catch {
      // best effort
    }
  }

  private async ingestPosition(body: Uint8Array) {
    // body = [ts:4 u32 unix, lat:4 f32, lon:4 f32] BE
    if (body.length < 12) return;
    const tsUnix = readU32BE(body, 0);
    const lat = readF32BE(body, 4);
    const lon = readF32BE(body, 8);
    const ts = new Date(tsUnix * 1000);
    const db = getDB();
    await db.prepare('INSERT INTO mower_gps (mower_id, ts, lat, lon) VALUES (?,?,?,?) ON DUPLICATE KEY UPDATE lat=VALUES(lat), lon=VALUES(lon)')
      .run(this.mowerId, ts, Number(lat.toFixed(6)), Number(lon.toFixed(6)));

    // Stuck detection: stato Mowing senza movimento significativo per >10 min
    try {
      await this.detectStuck(ts);
    } catch {
      // best effort
    }
  }

  private mapStateEnum(v: number): string {
    switch (v) {
      case 0: return 'StationChargingCompleted';
      case 1: return 'Mowing';
      case 2: return 'Docking';
      case 3: return 'Stuck';
      default: return 'Unknown';
    }
  }

  private handleResponseTimeout(iin: number) {
    const p = this.pendings.get(iin);
    if (!p) return;
    if (p.tries >= 3) {
      this.pendings.delete(iin);
      this.log('timeout', 'response 500ms');
      p.reject(new Error('response timeout'));
      return;
    }
    // retry same IIN per requisito: reinvia stesso IIN e aggiorna timer
    p.tries++;
    const { txKey } = this.session!.deriveKeys();
    const payloadNoMac = new Uint8Array(2 + p.body.length);
    payloadNoMac[0] = p.type;
    payloadNoMac[1] = iin;
    payloadNoMac.set(p.body, 2);
    const mac = this.session!.calcMAC(payloadNoMac.subarray(1), txKey);
    const payload = new Uint8Array(payloadNoMac.length + 4);
    payload.set(payloadNoMac);
    payload.set(u32be(mac), payloadNoMac.length);
    const frame = encode(payload);
    this.sock!.write(frame);
    clearTimeout(p.timer);
    p.timer = setTimeout(() => this.handleResponseTimeout(iin), this.responseTimeoutMs);
    this.pendings.set(iin, p);
  }

  private async log(event: string, info: string) {
    try {
      const db = getDB();
      await db.prepare('INSERT INTO conn_log (mower_id, ts, event, info, port) VALUES (?,?,?,?,?)')
        .run(this.mowerId, new Date(), event, info || null, this.port);
      try { logger.info(event, { port: this.port, mower_id: this.mowerId, ctx: info ? { info } : undefined }); } catch {}
      // FlakyConnection: >3 retry in 5 min
      if (event === 'retry') {
        try {
          const fiveMinAgo = new Date(Date.now() - 5 * 60 * 1000);
          const row = await db
            .prepare('SELECT COUNT(*) AS c FROM conn_log WHERE mower_id = ? AND event = ? AND ts >= ?')
            .get(this.mowerId, 'retry', fiveMinAgo) as { c: number } | undefined;
          const count = Number(row?.c || 0);
          if (count > 3) {
            const details = `retries=${count} in 5m`;
            await this.openOrUpdateAlert('FlakyConnection', details);
            try { logger.warn('FlakyConnection', { port: this.port, mower_id: this.mowerId, ctx: { retries: count } }); } catch {}
          }
        } catch {
          // ignore
        }
      }
    } catch (e) {
      // best effort
    }
  }

  // === Alerts helpers & detectors ===
  private async openOrUpdateAlert(type: string, details: string) {
    const db = getDB();
    const open = await db
      .prepare('SELECT id FROM mower_alert WHERE mower_id = ? AND type = ? AND ts_close IS NULL ORDER BY ts_open DESC LIMIT 1')
      .get(this.mowerId, type) as { id: number } | undefined;
    if (open) {
      try { await db.prepare('UPDATE mower_alert SET details = ? WHERE id = ?').run(details, open.id); } catch {}
      return;
    }
    try {
      await db.prepare('INSERT INTO mower_alert (mower_id, ts_open, ts_close, type, details) VALUES (?,?,?,?,?)')
        .run(this.mowerId, new Date(), null, type, details || null);
    } catch {
      // ignore
    }
  }

  private async detectStuck(nowTs: Date) {
    const db = getDB();
    // Check current state
    const stateRow = await db
      .prepare('SELECT state, ts FROM v_mower_latest_state WHERE mower_id = ?')
      .get(this.mowerId) as { state: string; ts: Date } | undefined;
    if (!stateRow || stateRow.state !== 'Mowing') return;

    const tenMinAgo = new Date(nowTs.getTime() - 10 * 60 * 1000);
    const rows = await db
      .prepare('SELECT ts, lat, lon FROM mower_gps WHERE mower_id = ? AND ts >= ? AND ts <= ? ORDER BY ts ASC')
      .all(this.mowerId, tenMinAgo, nowTs) as Array<{ ts: Date | string; lat: any; lon: any }>;
    if (!rows || rows.length < 2) return;

    // Require window >= 10 minutes
    const startTs = new Date(rows[0].ts as any);
    const endTs = new Date(rows[rows.length - 1].ts as any);
    if ((endTs.getTime() - startTs.getTime()) < 10 * 60 * 1000) return;

    const dist = this.totalDistanceFiltered(rows);
    const STUCK_DISTANCE_MIN_M = 10; // assunzione: movimento significativo >10m in 10min
    if (dist < STUCK_DISTANCE_MIN_M) {
      const details = `no_movement_${Math.round(dist)}m_10min`;
      await this.openOrUpdateAlert('Stuck', details);
    }
  }

  private totalDistanceFiltered(rows: Array<{ ts: any; lat: any; lon: any }>): number {
    const R = 6371000; // meters
    const toRad = (deg: number) => (deg * Math.PI) / 180;
    let meters = 0;
    for (let i = 1; i < rows.length; i++) {
      const a = rows[i - 1], b = rows[i];
      const lat1 = Number(a.lat), lon1 = Number(a.lon);
      const lat2 = Number(b.lat), lon2 = Number(b.lon);
      if (!isFinite(lat1) || !isFinite(lon1) || !isFinite(lat2) || !isFinite(lon2)) continue;
      const dLat = toRad(lat2 - lat1), dLon = toRad(lon2 - lon1);
      const la1 = toRad(lat1), la2 = toRad(lat2);
      const h = Math.sin(dLat / 2) ** 2 + Math.cos(la1) * Math.cos(la2) * Math.sin(dLon / 2) ** 2;
      const d = 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
      const ta = new Date(a.ts as any).getTime();
      const tb = new Date(b.ts as any).getTime();
      const dtMin = (tb - ta) / 60000;
      if (dtMin <= 0) continue;
      // outlier filter: >500 m/min
      if (d / dtMin > 500) continue;
      meters += d;
    }
    return meters;
  }
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

function u32be(n: number): Uint8Array {
  const b = new Uint8Array(4);
  b[0] = (n >>> 24) & 0xff;
  b[1] = (n >>> 16) & 0xff;
  b[2] = (n >>> 8) & 0xff;
  b[3] = n & 0xff;
  return b;
}

function readU32BE(buf: Uint8Array, off: number): number {
  return ((buf[off] << 24) | (buf[off + 1] << 16) | (buf[off + 2] << 8) | buf[off + 3]) >>> 0;
}

function readF32BE(buf: Uint8Array, off: number): number {
  const b = Buffer.allocUnsafe(4);
  b[0] = buf[off]; b[1] = buf[off + 1]; b[2] = buf[off + 2]; b[3] = buf[off + 3];
  return b.readFloatBE(0);
}
