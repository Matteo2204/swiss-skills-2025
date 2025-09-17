import {app, BrowserWindow, dialog, ipcMain} from 'electron';
import fs from 'node:fs/promises';
import fssync from 'node:fs';
import path from 'node:path';
import {IPC} from '../types';

// Config schema used across the app
export type DefaultView = 'overview' | 'battery' | 'map' | 'messages' | 'remote';
export interface AppConfigJson {
  BaseUrl?: string;
  LiveRangeSeconds?: number;        // [60, 3600]
  HistoryRangeHours?: number;       // [1, 168]
  BatteryLowThreshold?: number;     // [1, 50]
  StuckThresholdMinutes?: number;   // [1, 120]
  RefreshIntervalSeconds?: number;  // [1, 30]
  DefaultView?: DefaultView;
}

export function registerConfigHandlers() {
  ipcMain.handle(IPC.CONFIG_READ, async () => {
    const p = getConfigPath();
    try {
      const raw = await fs.readFile(p, { encoding: 'utf8' });
      let json: any;
      try {
        json = JSON.parse(raw);
      } catch {
        // Invalid JSON -> return defaults and mark invalid
        return { ok: true, path: p, invalid: true, config: defaultConfig() };
      }
      // Only accept plain object
      if (!json || typeof json !== 'object' || Array.isArray(json)) {
        return { ok: true, path: p, invalid: true, config: defaultConfig() };
      }
      return { ok: true, path: p, config: json as AppConfigJson };
    } catch (err: any) {
      // If file does not exist, return defaults (no error)
      if (err && (err.code === 'ENOENT' || err.code === 'ENOTDIR')) {
        return { ok: true, path: p, config: defaultConfig(), missing: true };
      }
      return { ok: false, error: String(err?.message || 'READ_FAILED') };
    }
  });

  ipcMain.handle(IPC.CONFIG_WRITE, async (_e, payload: { json: AppConfigJson }) => {
    if (!payload || typeof payload !== 'object' || !payload.json) {
      return { ok: false, error: 'INVALID_INPUT' };
    }
    const p = getConfigPath();
    try {
      // Ensure directory exists
      const dir = path.dirname(p);
      try { fssync.mkdirSync(dir, { recursive: true }); } catch {}
      const content = JSON.stringify(payload.json, null, 2);
      await fs.writeFile(p, content, { encoding: 'utf8' });
      return { ok: true, path: p };
    } catch (err: any) {
      return { ok: false, error: String(err?.message || 'WRITE_FAILED') };
    }
  });

  ipcMain.handle(IPC.DIALOG_SAVE_PATH, async (_e, { suggestedName }: { suggestedName?: string }) => {
    try {
      const res = await dialog.showSaveDialog({
        title: 'Seleziona percorso di salvataggio',
        defaultPath: suggestedName || undefined,
        properties: ['showOverwriteConfirmation', 'createDirectory'] as any,
      } as any);
      if (res.canceled || !res.filePath) return { ok: false, canceled: true };
      return { ok: true, path: res.filePath };
    } catch (err: any) {
      return { ok: false, error: String(err?.message || 'DIALOG_FAILED') };
    }
  });
}

function defaultConfig(): AppConfigJson {
  return {
    BaseUrl: 'http://10.211.55.3:3000',
    LiveRangeSeconds: 300,
    HistoryRangeHours: 24,
    BatteryLowThreshold: 10,
    StuckThresholdMinutes: 10,
    RefreshIntervalSeconds: 5,
    DefaultView: 'overview',
  };
}

function getConfigPath(): string {
  if (app.isPackaged) {
    const exe = path.basename(process.execPath);
    const name = path.parse(exe).name;
    const dir = path.dirname(process.execPath);
    return path.join(dir, `${name}.config`);
  } else {
    // Assunzione: in dev usiamo <projectRoot>/App.config
    return path.join(process.cwd(), 'App.config');
  }
}
