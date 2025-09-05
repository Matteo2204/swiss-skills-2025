import { ipcMain } from "electron";
import { getDB } from "../db";
import { requireRole } from "./auth";

export function registerItemHandlers() {
    ipcMain.handle("items:list", async (_e, { token }) => {
        await requireRole(token, ["ADMIN", "OPERATOR"]);
        const db = getDB();
        const rows = await db.prepare("SELECT id, name, created_at FROM items ORDER BY created_at DESC LIMIT 100").all();
        return { ok: true, data: rows };
    });

    ipcMain.handle("items:create", async (_e, { token, name }) => {
        await requireRole(token, ["ADMIN"]);
        if (!name || String(name).trim().length === 0) return { ok: false, error: "VALIDATION_NAME" };
        const db = getDB();
        const info = await db.prepare("INSERT INTO items (name) VALUES (?)").run(String(name).trim());
        return { ok: true, id: info.lastInsertRowid };
    });

    ipcMain.handle("items:delete", async (_e, { token, id }) => {
        await requireRole(token, ["ADMIN"]);
        const db = getDB();
        await db.prepare("DELETE FROM items WHERE id = ?").run(id);
        return { ok: true };
    });
}
