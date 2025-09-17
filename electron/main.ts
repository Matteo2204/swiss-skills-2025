import { app, BrowserWindow } from "electron";
import path from "path";
import { initDB } from "./db";
import { registerAuthHandlers } from "./ipc/auth"; // se hai anche altri handler, importali e chiamali
import { createExpressServer } from "./server";
import type { Server } from "http";
import { registerItemHandlers } from "./ipc/items";
import * as http from "node:http";

let win: BrowserWindow | null = null;
let expressServer: Server | null = null;
let bundledUrl: string | null = null;

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

    const useDevServer = !app.isPackaged;
    const devUrl = process.env.ELECTRON_START_URL ?? 'http://127.0.0.1:4200';
    let shouldUseDevServer = useDevServer;

    // Start Express API also in dev mode so Postman can reach /api endpoints.
    // Static UI may be missing in dev; server will skip UI routes if not found.
    if (!expressServer) {
        const staticRoot = path.join(__dirname, "ui");
        try {
            const { url, server } = await createExpressServer(staticRoot, 3000);
            expressServer = server;
            bundledUrl = url; // keep URL handy for potential fallback
            console.log('[main] Express API started at', url);
        } catch (e) {
            console.error('[main] failed to start Express API:', e);
        }
    }

    if (useDevServer) {
        try {
            await waitForDevServer(devUrl, 100000, 250);
        } catch (e) {
            console.error('[main] Dev server not ready:', e);
            shouldUseDevServer = false;
        }
    }

    let didFallback = false;
    win.webContents.on('did-fail-load', async (_e, code, desc, url, isMainFrame) => {
        console.error('[main] did-fail-load', { code, desc, url, isMainFrame });
        if (!didFallback && shouldUseDevServer && code === -102 /* ERR_CONNECTION_REFUSED */) {
            didFallback = true;
            shouldUseDevServer = false;
            if (win) {
                try {
                    await loadBundledUi(win);
                } catch (err) {
                    console.error('[main] fallback load failed:', err);
                }
            }
        }
    });
    win.webContents.on('did-finish-load', () => {
        console.log('[main] renderer loaded');
    });

    if (shouldUseDevServer) {
        await win.loadURL(devUrl);
    } else {
        await loadBundledUi(win);
    }

    win.once("ready-to-show", () => { win?.show(); win?.focus(); });

    win.on("closed", () => {
        win = null;
        if (expressServer) {
            try { expressServer.close(); } catch { /* noop */ }
            expressServer = null;
            bundledUrl = null;
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
app.on("before-quit", async () => {
    try { expressServer?.close(); } catch {}
    finally {
        expressServer = null;
        bundledUrl = null;
    }
});
app.on("window-all-closed", () => { if (process.platform !== "darwin") app.quit(); });

async function loadBundledUi(target: BrowserWindow): Promise<void> {
    const staticRoot = path.join(__dirname, "ui");
    if (!expressServer) {
        const { url, server } = await createExpressServer(staticRoot, 3000);
        expressServer = server;
        bundledUrl = url;
        console.log('[main] Serving bundled UI →', url);
    }
    if (!bundledUrl) throw new Error('Bundled UI URL missing after server start');
    await target.loadURL(bundledUrl);
}
