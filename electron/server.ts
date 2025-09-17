// electron/server.ts
import express from "express";
import path from "path";
import type { Server } from "http";

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
    preferredPort = 3020
): Promise<{ url: string; server: Server }> {
    const app = express();

    // CSP semplice
    const csp = [
        "default-src 'self'",
        // Allow inline handlers used by Angular to lazy-load CSS (<link onload=…> pattern)
        "script-src 'self' 'unsafe-inline'",
        "style-src 'self' 'unsafe-inline'",
        "img-src 'self' data: blob:",
        "font-src 'self' data:",
        // Allow local HTTP server only; extend if backend runs elsewhere
        "connect-src 'self' http: https: ws: wss:",
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

    // Statici (niente index auto)
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

// Dev helper: tiny Express that redirects all requests to a target URL (e.g. Angular dev server)
export async function createExpressRedirectServer(
    targetUrl: string,
    preferredPort = 3020
): Promise<{ url: string; server: Server }> {
    const app = express();

    // No CSP on redirect responses in dev to avoid interfering with Angular dev server

    // Root redirect
    app.get("/", (_req, res) => res.redirect(302, targetUrl));

    // Express 5: use RegExp fallback, preserve original URL for path
    app.get(/.*/, (req, res) => res.redirect(302, targetUrl + req.originalUrl));

    let server: Server;
    try {
        server = await listen(app, preferredPort);
        console.log(`[server] Express (dev redirect) on http://127.0.0.1:${preferredPort} → ${targetUrl}`);
    } catch (err: any) {
        console.warn(`[server] Port ${preferredPort} busy (${err?.code}). Falling back to random port.`);
        server = await listen(app, 0);
        const addr = server.address();
        const p = typeof addr === "object" && addr ? addr.port : 0;
        console.log(`[server] Express (dev redirect) on http://127.0.0.1:${p} → ${targetUrl}`);
    }

    const addr = server.address();
    const port = typeof addr === "object" && addr ? addr.port : preferredPort;
    const url = `http://127.0.0.1:${port}`;
    return { url, server };
}
