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
        const stmt = db.prepare<[string], DbUserRow>(
            "SELECT id, username, password_hash, role FROM users WHERE username = ?"
        );

        const row = stmt.get(username); // row: DbUserRow | undefined

        if (!row) return { ok: false, error: "INVALID_CREDENTIALS" };

        const ok = await argon2.verify(row.password_hash, password);
        if (!ok) return { ok: false, error: "INVALID_CREDENTIALS" };

        // Crea un token di sessione (in-memory)
        const token = crypto.randomBytes(24).toString("base64url");
        sessions.set(token, { user_id: row.id, role: row.role, created_at: Date.now() });

        return {
            ok: true,
            token,
            user: { id: row.id, username: row.username, role: row.role }
        };
    });

    // LOGOUT
    ipcMain.handle(IPC.AUTH_LOGOUT, async (_e, { token }: { token?: string }) => {
        if (token) sessions.delete(token);
        return { ok: true };
    });

    ipcMain.handle(IPC.AUTH_REGISTER, async (_e, { username, password }) => {
        const db = getDB();

        const u = String(username ?? '').trim();
        const p = String(password ?? '');
        if (!u || !p) return { ok: false, error: 'INVALID_INPUT' };

        // esiste già?
        const exists = db.prepare('SELECT 1 FROM users WHERE username = ?').get(u);
        if (exists) return { ok: false, error: 'USERNAME_TAKEN' };

        try {
            const hash = await argon2.hash(p);
            const role: Role = 'OPERATOR'; // default
            db.prepare('INSERT INTO users (username, password_hash, role) VALUES (?,?,?)').run(u, hash, role);
            return { ok: true };
        } catch (err: any) {
            if (err?.code === 'SQLITE_CONSTRAINT' || err?.code === 'SQLITE_CONSTRAINT_UNIQUE') {
                return { ok: false, error: 'USERNAME_TAKEN' };
            }
            console.error('[auth:register] error', err);
            return { ok: false, error: 'DB_ERROR' };
        }
    });
}

// Guardia di ruolo per altri handler IPC
export function requireRole(token: string | undefined, roles: Role[]) {
    if (!token) throw new Error("UNAUTHORIZED");
    const s = sessions.get(token);
    if (!s) throw new Error("UNAUTHORIZED");
    if (!roles.includes(s.role)) throw new Error("FORBIDDEN");
    return s; // { user_id, role, created_at }
}