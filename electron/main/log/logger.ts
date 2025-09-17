import fs from 'fs';
import path from 'path';
import { app } from 'electron';

type Level = 'debug' | 'info' | 'warn' | 'error';

type LogCtx = Record<string, any> | undefined;

type LogLine = {
  ts: string; // ISO with ms
  level: Level;
  msg: string;
  iin?: number | null;
  port?: number | null;
  mower_id?: number | null;
  ctx?: LogCtx;
};

function isoNow(): string {
  const d = new Date();
  return d.toISOString();
}

function isDev(): boolean {
  try { return !app.isPackaged; } catch { return process.env.NODE_ENV !== 'production'; }
}

function ensureLogsDir(): string {
  let baseDir: string;
  try {
    baseDir = app.isPackaged ? path.dirname(app.getPath('exe')) : process.cwd();
  } catch {
    baseDir = process.cwd();
  }
  const logsDir = path.join(baseDir, 'logs');
  try { if (!fs.existsSync(logsDir)) fs.mkdirSync(logsDir, { recursive: true }); } catch {}
  return logsDir;
}

const MAX_BYTES = 5 * 1024 * 1024; // 5MB

export class Logger {
  private logPath: string;

  constructor(filename = 'app.log') {
    const dir = ensureLogsDir();
    this.logPath = path.join(dir, filename);
  }

  private rotateIfNeeded() {
    try {
      const st = fs.existsSync(this.logPath) ? fs.statSync(this.logPath) : null;
      if (st && st.size >= MAX_BYTES) {
        const bak = this.logPath + '.1';
        try { if (fs.existsSync(bak)) fs.unlinkSync(bak); } catch {}
        try { fs.renameSync(this.logPath, bak); } catch {}
        try { fs.writeFileSync(this.logPath, ''); } catch {}
      }
    } catch {
      // ignore
    }
  }

  private write(line: LogLine) {
    const json = JSON.stringify(line);
    try {
      this.rotateIfNeeded();
      fs.appendFileSync(this.logPath, json + '\n');
    } catch {
      // ignore
    }
    if (isDev()) {
      const toConsole = line.level === 'error' ? console.error : (line.level === 'warn' ? console.warn : console.log);
      try { toConsole('[log]', json); } catch {}
    }
  }

  log(level: Level, msg: string, opts?: { iin?: number | null; port?: number | null; mower_id?: number | null; ctx?: LogCtx }) {
    const line: LogLine = {
      ts: isoNow(),
      level,
      msg,
      iin: opts?.iin ?? undefined,
      port: opts?.port ?? undefined,
      mower_id: opts?.mower_id ?? undefined,
      ctx: opts?.ctx,
    };
    this.write(line);
  }

  debug(msg: string, opts?: Parameters<Logger['log']>[2]) { this.log('debug', msg, opts); }
  info(msg: string, opts?: Parameters<Logger['log']>[2]) { this.log('info', msg, opts); }
  warn(msg: string, opts?: Parameters<Logger['log']>[2]) { this.log('warn', msg, opts); }
  error(msg: string, opts?: Parameters<Logger['log']>[2]) { this.log('error', msg, opts); }
}

export const logger = new Logger();

