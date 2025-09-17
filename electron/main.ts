import { app, BrowserWindow } from "electron";
import path from "path";
import { initDB } from "./db";
import { registerAuthHandlers } from "./ipc/auth"; // se hai anche altri handler, importali e chiamali
import { createExpressServer, createExpressRedirectServer } from "./server";
import type { Server } from "http";
import {registerExportHandlers} from "./ipc/export";
import {registerConfigHandlers} from "./ipc/config";
import * as http from "node:http";

// Log non-fatal process errors to avoid silent exits in dev
process.on('unhandledRejection', (e) => console.error('[main] unhandledRejection', e));
process.on('uncaughtException', (e) => console.error('[main] uncaughtException', e));

let win: BrowserWindow | null = null;
let expressServer: Server | null = null;

// In dev, avoid single-instance lock to prevent accidental early exits
const gotLock = app.isPackaged ? app.requestSingleInstanceLock() : true;
if (app.isPackaged && !gotLock) app.quit();
else {
    app.on("second-instance", () => {
        if (win) { if (win.isMinimized()) win.restore(); win.show(); win.focus(); }
    });
}

async function createWindow() {
    // In dev, do not crash if DB is temporarily unavailable
    try {
        await initDB();
    } catch (e) {
        console.error('[main] initDB failed (non-fatal):', e);
    }
    registerAuthHandlers();
    registerExportHandlers();
    registerConfigHandlers();

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
        const devUrl = 'http://localhost:4200';
        try {
            await waitForDevServer(devUrl, 30000, 250);
        } catch (e) {
            console.error('[main] Dev server not ready:', e);
        }

        // Boot a tiny Express in dev as well, so you see the Express logs
        const { url, server } = await createExpressRedirectServer(devUrl, 3020);
        expressServer = server;

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
        const { url, server } = await createExpressServer(staticRoot, 3020);
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

app.whenReady().then(createWindow).catch((e) => console.error('[main] startup error', e));
app.on("before-quit", async () => { try { expressServer?.close(); } catch {} });
app.on("window-all-closed", () => { if (process.platform !== "darwin") app.quit(); });
