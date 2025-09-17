import { TcpClient, ClientOptions } from './client';
import { logger } from '../log/logger';

export class TcpManager {
  private clients: Map<number, TcpClient> = new Map(); // key: port
  private mapping: Map<number, number> = new Map(); // port -> mowerId

  constructor(initialMapping?: Record<number, number>) {
    if (initialMapping) {
      for (const [p, id] of Object.entries(initialMapping)) {
        this.mapping.set(Number(p), id);
      }
    }
  }

  setMapping(port: number, mowerId: number) { this.mapping.set(port, mowerId); }
  removeMapping(port: number) { this.mapping.delete(port); }

  getPortByMowerId(mowerId: number): number | undefined {
    for (const [port, id] of this.mapping.entries()) if (id === mowerId) return port;
    return undefined;
  }

  getClientByMowerId(mowerId: number): { port: number; client: TcpClient } | undefined {
    const port = this.getPortByMowerId(mowerId);
    if (port == null) return undefined;
    const client = this.clients.get(port);
    if (!client) return undefined;
    return { port, client };
  }

  start(port: number, opts: ClientOptions = {}) {
    const mowerId = this.mapping.get(port);
    if (!mowerId) throw new Error(`No mowerId mapping for port ${port}`);
    if (this.clients.has(port)) return; // already started
    const c = new TcpClient(port, mowerId, opts);
    this.clients.set(port, c);
    c.start();
    try { logger.info('client_start', { port, mower_id: mowerId }); } catch {}
  }

  stop(port: number) {
    const c = this.clients.get(port);
    if (!c) return;
    c.stop();
    this.clients.delete(port);
    const mowerId = this.mapping.get(port);
    try { logger.info('client_stop', { port, mower_id: mowerId }); } catch {}
  }

  async sendAction(port: number, action: 'start'|'stop'|'home'|'ackerror'|'resetblade'): Promise<{ ok: boolean; code?: number; iin: number }> {
    const c = this.clients.get(port);
    if (!c) throw new Error(`Client for port ${port} not started`);
    switch (action) {
      case 'start': return await c.send(0x01, new Uint8Array([0x01])) as any;
      case 'stop': return await c.send(0x01, new Uint8Array([0x00])) as any;
      case 'home': return await c.send(0x01, new Uint8Array([0x02])) as any;
      case 'ackerror': return await c.send(0x02, new Uint8Array(0)) as any;
      case 'resetblade': return await c.send(0x03, new Uint8Array(0)) as any;
    }
  }
}

// Optional singleton (used by API when present). Not auto-started.
export const tcpManager = new TcpManager();
