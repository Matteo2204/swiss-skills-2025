import { spawn, spawnSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import net from 'net';
import { app } from 'electron';
import mysql from 'mysql2/promise';
import https from 'https';
import { pipeline } from 'stream';
import { promisify } from 'util';
import extract from 'extract-zip';

const streamPipeline = promisify(pipeline);

let sidecarLogPath: string | null = null;
function log(...a: unknown[]) {
  const line = `[mysql-sidecar] ${a.map(x => typeof x === 'string' ? x : JSON.stringify(x)).join(' ')}\n`;
  console.log(line.trimEnd());
  if (sidecarLogPath) {
    try { fs.appendFileSync(sidecarLogPath, line); } catch {}
  }
}

export interface MysqlConnInfo {
  host: string;
  port: number;
  user: string;
  password: string;
  database: string;
  socketPath?: string;
}

function fileExists(p: string): boolean { try { return fs.existsSync(p); } catch { return false; } }

function getResourcesDir(): string {
  // In dev, use project root; in packaged, use process.resourcesPath
  return app.isPackaged ? process.resourcesPath : process.cwd();
}

function platformId(): string {
  // e.g., darwin-arm64, darwin-x64, win32-x64, linux-x64
  return `${process.platform}-${process.arch}`;
}

function resolveMysqlBin(runtimeBase?: string): { mysqld: string; basedir?: string } | null {
  const resBase = path.join(getResourcesDir(), 'resources', 'mysql', platformId());
  const runBase = runtimeBase ? path.join(runtimeBase, 'runtime', 'mysql', platformId()) : undefined;
  const candidates: Array<{ mysqld: string; basedir?: string }> = [];
  if (runBase) {
    candidates.push({ mysqld: path.join(runBase, 'bin', process.platform === 'win32' ? 'mysqld.exe' : 'mysqld'), basedir: runBase });
  }
  candidates.push({ mysqld: path.join(resBase, 'bin', process.platform === 'win32' ? 'mysqld.exe' : 'mysqld'), basedir: resBase });
  for (const c of candidates) if (fileExists(c.mysqld)) return c;

  // Fallback: try PATH
  const pathEnv = process.env.PATH || '';
  for (const dir of pathEnv.split(path.delimiter)) {
    const p = path.join(dir, process.platform === 'win32' ? 'mysqld.exe' : 'mysqld');
    if (fileExists(p)) return { mysqld: p };
  }
  return null;
}

async function downloadFile(url: string, destPath: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const file = fs.createWriteStream(destPath);
    https.get(url, res => {
      if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        // redirect
        downloadFile(res.headers.location, destPath).then(resolve, reject);
        return;
      }
      if (res.statusCode !== 200) {
        reject(new Error(`HTTP ${res.statusCode}`));
        return;
      }
      res.pipe(file);
      file.on('finish', () => file.close(() => resolve()));
    }).on('error', reject);
  });
}

async function ensureMysqlBinaries(dataRoot: string): Promise<{ mysqld: string; basedir?: string }> {
  // Try resolve from runtime or resources
  const resolved = resolveMysqlBin(dataRoot);
  if (resolved) return resolved;

  // If not available, try download if configured
  const url = process.env.MYSQL_BUNDLE_URL;
  const sha256 = process.env.MYSQL_BUNDLE_SHA256;
  if (!url) throw new Error('mysqld not found and MYSQL_BUNDLE_URL not set for first-run download');

  const downloads = path.join(dataRoot, 'downloads');
  ensureDir(downloads);
  const archive = path.join(downloads, 'mysql-bundle.zip');
  log('Downloading MySQL bundle…', url);
  await downloadFile(url, archive);

  if (sha256) {
    const { createHash } = await import('crypto');
    const hash = createHash('sha256');
    const buf = fs.readFileSync(archive);
    hash.update(buf);
    const hex = hash.digest('hex');
    if (hex.toLowerCase() !== sha256.toLowerCase()) {
      throw new Error(`Checksum mismatch for MySQL bundle: expected ${sha256}, got ${hex}`);
    }
  }

  // Extract to runtime folder expected by resolver
  const runBase = path.join(dataRoot, 'runtime', 'mysql', platformId());
  ensureDir(runBase);
  log('Extracting MySQL bundle to', runBase);
  await extract(archive, { dir: runBase });

  // After extraction we expect bin/mysqld[.exe] exists under runBase/bin
  const finalResolved = resolveMysqlBin(dataRoot);
  if (!finalResolved) throw new Error('mysqld not found after extraction');
  // Make sure executable bit on Unix
  try { if (process.platform !== 'win32') fs.chmodSync(finalResolved.mysqld, 0o755); } catch {}
  return finalResolved;
}

async function findFreePort(preferred = 3307): Promise<number> {
  function tryPort(port: number): Promise<boolean> {
    return new Promise((resolve) => {
      const srv = net.createServer();
      srv.once('error', () => resolve(false));
      srv.once('listening', () => srv.close(() => resolve(true)));
      srv.listen(port, '127.0.0.1');
    });
  }
  if (await tryPort(preferred)) return preferred;
  for (let p = 3308; p < 3500; p++) {
    if (await tryPort(p)) return p;
  }
  throw new Error('No free port for MySQL sidecar');
}

function ensureDir(p: string) { fs.mkdirSync(p, { recursive: true }); }

function writeJSON(p: string, data: any) { fs.writeFileSync(p, JSON.stringify(data, null, 2)); }
function readJSON<T>(p: string): T | null { try { return JSON.parse(fs.readFileSync(p, 'utf8')) as T; } catch { return null; } }

async function waitForPort(host: string, port: number, timeoutMs = 30000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      await new Promise<void>((resolve, reject) => {
        const sock = net.createConnection({ host, port });
        sock.once('connect', () => { sock.destroy(); resolve(); });
        sock.once('error', reject);
      });
      return;
    } catch {}
    await new Promise(r => setTimeout(r, 250));
  }
  throw new Error(`MySQL not ready on ${host}:${port}`);
}

export async function ensureLocalMysqlIfNeeded(baseDataDir: string): Promise<MysqlConnInfo | null> {
  // If external config is present, we do nothing.
  if (process.env.MYSQL_HOST || process.env.MYSQL_DATABASE || process.env.MYSQL_USER) {
    log('External MySQL env detected; skipping sidecar');
    return null;
  }

  // Setup log file
  const dataRoot = path.join(baseDataDir, 'db', 'mysql');
  const logs = path.join(dataRoot, 'logs');
  ensureDir(logs);
  sidecarLogPath = path.join(logs, 'sidecar.log');

  const resolved = await ensureMysqlBinaries(path.join(baseDataDir, 'db', 'mysql'))
    .catch(e => {
      log('ensureMysqlBinaries failed:', (e as Error)?.message);
      return resolveMysqlBin(path.join(baseDataDir, 'db', 'mysql'));
    });
  if (!resolved) {
    throw new Error('mysqld not found. Bundle under resources/mysql/<platform>/bin, configure MYSQL_BUNDLE_URL for download, or set MYSQL_* for external DB.');
  }

  const datadir = path.join(dataRoot, 'datadir');
  const rundir = path.join(dataRoot, 'run');
  const credsFile = path.join(dataRoot, 'local-creds.json');
  const stateFile = path.join(dataRoot, 'state.json');
  ensureDir(datadir); ensureDir(rundir); ensureDir(logs);

  // Try to reuse existing running instance (dev restarts)
  const sockPath = process.platform === 'win32' ? undefined : path.join(rundir, 'mysqld.sock');
  const savedState = readJSON<{ port?: number }>(stateFile);
  const savedCreds = readJSON<{ user: string; password: string }>(credsFile);
  if (savedCreds) {
    // Prefer socket if present
    if (sockPath && fs.existsSync(sockPath)) {
      try {
        const c = await mysql.createConnection({ socketPath: sockPath, user: savedCreds.user, password: savedCreds.password, database: 'appdb' });
        await c.query('SELECT 1'); await c.end();
        log('Reusing existing MySQL via socket');
        return { host: 'localhost', port: savedState?.port ?? 3307, user: savedCreds.user, password: savedCreds.password, database: 'appdb', socketPath: sockPath };
      } catch {}
    }
    if (savedState?.port) {
      try {
        const c = await mysql.createConnection({ host: 'localhost', port: savedState.port, user: savedCreds.user, password: savedCreds.password, database: 'appdb' });
        await c.query('SELECT 1'); await c.end();
        log('Reusing existing MySQL on port', String(savedState.port));
        return { host: 'localhost', port: savedState.port, user: savedCreds.user, password: savedCreds.password, database: 'appdb', socketPath: sockPath };
      } catch {}
    }
  }

  // Initialize if empty
  if (!fileExists(path.join(datadir, 'ibdata1'))) {
    log('Initializing MySQL data directory...');
    const args = ['--initialize-insecure', `--datadir=${datadir}`];
    if (resolved.basedir) args.push(`--basedir=${resolved.basedir}`);
    const res = spawnSync(resolved.mysqld, args, { stdio: 'inherit' });
    if (res.status !== 0) throw new Error('mysqld initialize failed');
  }

  const port = await findFreePort(3307);
  const errLog = path.join(logs, 'mysqld.err');
  const pidFile = path.join(rundir, 'mysqld.pid');
  const socketPath = sockPath;

  const runArgs = [
    `--datadir=${datadir}`,
    `--port=${port}`,
    `--bind-address=127.0.0.1`,
    `--skip-name-resolve`,
    `--log-error=${errLog}`,
    `--pid-file=${pidFile}`,
  ];
  if (socketPath) runArgs.push(`--socket=${socketPath}`);
  if (resolved.basedir) runArgs.push(`--basedir=${resolved.basedir}`);

  log('Starting mysqld:', resolved.mysqld, runArgs.join(' '));
  const child = spawn(resolved.mysqld, runArgs, { detached: false, stdio: 'ignore' });
  child.unref();

  // Track current process for graceful shutdown
  currentSidecar = {
    host: '127.0.0.1',
    port,
    pid: child.pid ?? undefined,
    pidFile,
    datadir,
  };

  // Wait until port is open (or socket accepts connections)
  try {
    await waitForPort('127.0.0.1', port, 45000);
  } catch (e) {
    if (socketPath) {
      try {
        const c = await mysql.createConnection({ socketPath, user: 'root', password: '' });
        await c.query('SELECT 1'); await c.end();
      } catch {
        throw e;
      }
    } else {
      throw e;
    }
  }

  // Create app DB and user
  const database = 'appdb';
  let creds = readJSON<{ user: string; password: string }>(credsFile);
  if (!creds) {
    const { randomBytes } = await import('crypto');
    creds = { user: 'appuser', password: randomBytes(18).toString('base64url') };
    writeJSON(credsFile, creds);
  }

  const rootConnConf: any = socketPath
    ? { user: 'root', password: '', socketPath }
    : { host: 'localhost', port, user: 'root', password: '' };
  const conn = await mysql.createConnection(rootConnConf);
  try {
    await conn.query(`CREATE DATABASE IF NOT EXISTS \`${database}\``);
    // Create user for both 'localhost' and '127.0.0.1' to ease TCP tools configuration
    await conn.query(`CREATE USER IF NOT EXISTS '${creds.user}'@'localhost' IDENTIFIED BY '${creds.password}'`);
    await conn.query(`CREATE USER IF NOT EXISTS '${creds.user}'@'127.0.0.1' IDENTIFIED BY '${creds.password}'`);
    await conn.query(`GRANT ALL PRIVILEGES ON \`${database}\`.* TO '${creds.user}'@'localhost'`);
    await conn.query(`GRANT ALL PRIVILEGES ON \`${database}\`.* TO '${creds.user}'@'127.0.0.1'`);
    await conn.query(`FLUSH PRIVILEGES`);
  } finally {
    await conn.end();
  }

  const info: MysqlConnInfo = {
    host: 'localhost',
    port,
    user: creds.user,
    password: creds.password,
    database,
    socketPath,
  };
  // Persist the current port for reuse on next dev restart
  writeJSON(stateFile, { port });
  log('Local MySQL ready on', `${info.host}:${info.port}`, 'db', database, 'user', info.user);
  return info;
}

// --- Graceful shutdown support ---
let currentSidecar: { host: string; port: number; pid?: number; pidFile: string; datadir: string } | null = null;

async function waitPortClosed(host: string, port: number, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const ok = await new Promise<boolean>((resolve) => {
      const sock = net.createConnection({ host, port });
      const done = (v: boolean) => { try { sock.destroy(); } catch {} resolve(v); };
      sock.once('connect', () => done(true));
      sock.once('error', () => done(false));
    });
    if (!ok) return; // not connectable -> closed
    await new Promise(r => setTimeout(r, 200));
  }
  throw new Error('MySQL did not stop in time');
}

export async function stopLocalMysql(): Promise<void> {
  if (!currentSidecar) return; // nothing to stop
  const { host, port, pid, pidFile } = currentSidecar;
  log('Stopping local MySQL…');
  // 1) Try SQL SHUTDOWN using root without password (initialize-insecure)
  try {
    const conn = await mysql.createConnection({ host, port, user: 'root', password: '' });
    try { await conn.query('SHUTDOWN'); } finally { await conn.end(); }
  } catch (e) {
    log('SQL shutdown failed/ignored:', (e as Error)?.message);
  }

  // 2) Wait for port to close a bit
  try { await waitPortClosed(host, port, 5000); return; } catch {}

  // 3) Fallback: kill by PID
  let targetPid: number | undefined = pid;
  if (!targetPid && fs.existsSync(pidFile)) {
    try { targetPid = Number(fs.readFileSync(pidFile, 'utf8').trim()); } catch {}
  }
  if (targetPid && Number.isFinite(targetPid)) {
    try {
      process.kill(targetPid, process.platform === 'win32' ? undefined : 'SIGTERM');
    } catch (e) {
      log('Process kill failed:', (e as Error)?.message);
    }
  }
  try { await waitPortClosed(host, port, 5000); } catch {}
  currentSidecar = null;
}
