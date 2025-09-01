import { app, BrowserWindow } from "electron";
import path from "path";
import { initDB } from "./db";
import { registerAuthHandlers } from "./ipc/auth"; // se hai anche altri handler, importali e chiamali
import { createExpressServer } from "./server";
import type { Server } from "http";
import {registerItemHandlers} from "./ipc/items";
import * as http from "node:http";

let win: BrowserWindow | null = null;
let expressServer: Server | null = null;

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) app.quit();
else {
    app.on("second-instance", () => {
        if (win) { if (win.isMinimized()) win.restore(); win.show(); win.focus(); }
    });
}

async function createWindow() {
    await initDB();
    registerAuthHandlers();
    registerItemHandlers();

    win = new BrowserWindow({
        width: 1200,
        height: 800,
        show: true,
        webPreferences: {
            preload: path.join(__dirname, "preload.js"),
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: true
        }
    });

    if (!app.isPackaged) {
        const url = 'http://127.0.0.1:4200';
        try {
            await waitForDevServer(url, 30000, 250);
        } catch (e) {
            console.error('[main] Dev server not ready:', e);
        }
        win.webContents.on('did-fail-load', (_e, code, desc, _url, isMainFrame) => {
            console.error('[main] did-fail-load', { code, desc, isMainFrame });
        });
        win.webContents.on('did-finish-load', () => {
            console.log('[main] renderer loaded');
        });

        await win.loadURL(url);
    } else {
        // SERVE UI CON EXPRESS (stile progetto vecchio)
        const staticRoot = path.join(__dirname, "ui"); // <— assicurati che la build Angular sia copiata qui
        const { url, server } = await createExpressServer(staticRoot, 3000);
        expressServer = server;
        console.log("[main] PACKAGED →", url);
        await win.loadURL(url);
    }

    win.once("ready-to-show", () => { win?.show(); win?.focus(); });

    win.on("closed", () => {
        win = null;
        if (expressServer) {
            try { expressServer.close(); } catch { /* noop */ }
            expressServer = null;
        }
    });
}


async function waitForDevServer(url: string, timeoutMs = 30000, intervalMs = 250): Promise<void> {
    const deadline = Date.now() + timeoutMs;

    const tryOnce = () =>
        new Promise<boolean>((resolve) => {
            // Usa http.get per evitare redirect CORS/fetch problemi
            const req = http.get(url, { timeout: 2000 }, (res) => {
                res.resume(); // scarta il body
                resolve(res.statusCode !== undefined && res.statusCode >= 200 && res.statusCode < 500);
            });
            req.on('error', () => resolve(false));
            req.on('timeout', () => {
                req.destroy();
                resolve(false);
            });
        });

    while (Date.now() < deadline) {
        if (await tryOnce()) return;
        await new Promise((r) => setTimeout(r, intervalMs));
    }
    throw new Error(`Dev server not reachable at ${url} within ${timeoutMs}ms`);
}

app.whenReady().then(createWindow);
app.on("before-quit", () => { try { expressServer?.close(); } catch {} });
app.on("window-all-closed", () => { if (process.platform !== "darwin") app.quit(); });