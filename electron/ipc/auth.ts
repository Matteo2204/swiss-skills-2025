// electron/ipc/auth.ts
import { ipcMain } from "electron";
import { getDB } from "../db";
import { IPC, Role } from "../types";
import argon2 from "argon2";
import crypto from "crypto";

// --- Tipi del record che torna dalla SELECT ---
interface DbUserRow {
    id: number;
    username: string;
    password_hash: string;
    role: Role;
}

// Sessioni in-memory (ok per la gara; se serve, puoi persistere)
const sessions = new Map<string, { user_id: number; role: Role; created_at: number }>();

export function registerAuthHandlers() {
    console.log("[ipc] registering", IPC.AUTH_LOGIN, IPC.AUTH_LOGOUT);

    // LOGIN
    ipcMain.handle(IPC.AUTH_LOGIN, async (_e, { username, password }: { username: string; password: string }) => {
        const db = getDB();

        // Tipiamo la statement: bind [string], result DbUserRow
        const stmt = db.prepare(
            "SELECT id, username, password_hash, role FROM users WHERE username = ?"
        );

        const row = await stmt.get(username) as DbUserRow | undefined; // row: DbUserRow | undefined

        if (!row) return { ok: false, error: "INVALID_CREDENTIALS" };

        const ok = await argon2.verify(row.password_hash, password);
        if (!ok) return { ok: false, error: "INVALID_CREDENTIALS" };

        // Crea un token di sessione (persistente)
        const token = crypto.randomBytes(24).toString("base64url");
        try {
            await getDB().prepare('INSERT INTO sessions (token, user_id, role) VALUES (?,?,?)').run(token, row.id, row.role);
        } catch (e) {
            // ignore duplicate or transient errors; we'll still return the token
        }
        sessions.set(token, { user_id: row.id, role: row.role, created_at: Date.now() });

        return {
            ok: true,
            token,
            user: { id: row.id, username: row.username, role: row.role }
        };
    });

    // LOGOUT
    ipcMain.handle(IPC.AUTH_LOGOUT, async (_e, payload: any) => {
        const token: string | undefined = typeof payload === 'string' ? payload : payload?.token;
        if (token) {
            sessions.delete(token);
            try { await getDB().prepare('DELETE FROM sessions WHERE token = ?').run(token); } catch {}
        }
        return { ok: true };
    });

    ipcMain.handle(IPC.AUTH_REGISTER, async (_e, { username, password }) => {
        const db = getDB();

        const u = String(username ?? '').trim();
        const p = String(password ?? '');
        if (!u || !p) return { ok: false, error: 'INVALID_INPUT' };

        // esiste già?
        const exists = await db.prepare('SELECT 1 FROM users WHERE username = ?').get(u);
        if (exists) return { ok: false, error: 'USERNAME_TAKEN' };

        try {
            const hash = await argon2.hash(p);
            const role: Role = 'OPERATOR'; // default
            await db.prepare('INSERT INTO users (username, password_hash, role) VALUES (?,?,?)').run(u, hash, role);
            return { ok: true };
        } catch (err: any) {
            // Handle duplicate key errors (MySQL)
            if (err?.code === 'ER_DUP_ENTRY' || err?.errno === 1062) {
                return { ok: false, error: 'USERNAME_TAKEN' };
            }
            console.error('[auth:register] error', err);
            return { ok: false, error: 'DB_ERROR' };
        }
    });

    // Validate current session token and return user if valid
    ipcMain.handle(IPC.AUTH_ME, async (_e, { token }: { token?: string }) => {
        if (!token) return { ok: false };
        let s = sessions.get(token);
        if (!s) {
            const row = await getDB().prepare('SELECT user_id, role FROM sessions WHERE token = ?').get(token) as { user_id: number; role: Role } | undefined;
            if (row) { s = { user_id: row.user_id, role: row.role, created_at: Date.now() }; sessions.set(token, s); }
        }
        if (!s) return { ok: false };
        const user = await getDB().prepare('SELECT id, username, role FROM users WHERE id = ?').get(s.user_id) as { id: number; username: string; role: Role } | undefined;
        if (!user) return { ok: false };
        return { ok: true, user };
    });

}

// Guardia di ruolo per altri handler IPC
export async function requireRole(token: string | undefined, roles: Role[]) {
    if (!token) throw new Error("UNAUTHORIZED");
    let s = sessions.get(token);
    if (!s) {
        // fall back to persistent sessions in DB
        const row = await getDB().prepare('SELECT user_id, role FROM sessions WHERE token = ?').get(token) as { user_id: number; role: Role } | undefined;
        if (row) {
            s = { user_id: row.user_id, role: row.role, created_at: Date.now() };
            sessions.set(token, s);
        }
    }
    if (!s) throw new Error("UNAUTHORIZED");
    if (!roles.includes(s.role)) throw new Error("FORBIDDEN");
    return s; // { user_id, role, created_at }
}
