import {ipcMain, dialog, BrowserWindow} from 'electron';
import fs from 'node:fs/promises';
import path from 'node:path';
import { IPC } from '../types';

interface SaveJsonPayload {
  suggestedFileName: string; // e.g., mower-1-20240917-154501.json
  content: string; // JSON string (UTF-8, no BOM)
}

export function registerExportHandlers() {
  ipcMain.handle(IPC.EXPORT_SAVE_JSON, async (_e, payload: SaveJsonPayload) => {
    const { suggestedFileName, content } = payload || ({} as SaveJsonPayload);
    if (!suggestedFileName || !content) {
      return { ok: false, error: 'INVALID_INPUT' };
    }

    const res = await dialog.showOpenDialog({
      title: 'Seleziona cartella di destinazione',
      properties: ['openDirectory', 'createDirectory'],
    });
    if (res.canceled || !res.filePaths?.length) {
      return { ok: false, canceled: true };
    }
    const dir = res.filePaths[0];
    const target = path.join(dir, suggestedFileName);
    try {
      await fs.writeFile(target, content, { encoding: 'utf8' });
      return { ok: true, path: target };
    } catch (err: any) {
      return { ok: false, error: String(err?.message || 'WRITE_FAILED') };
    }
  });
}
