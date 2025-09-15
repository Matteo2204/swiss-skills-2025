import crypto from "crypto";

// Scrypt parameters (safe defaults; CPU/memory-hard and cross-platform)
const SCRYPT_N = 16384; // 2^14
const SCRYPT_r = 8;
const SCRYPT_p = 1;
const KEYLEN = 64; // derived key length
const SALT_BYTES = 16;

function b64(buf: Buffer): string {
    return buf.toString("base64");
}

function ub64(s: string): Buffer {
    return Buffer.from(s, "base64");
}

// PHC-like encoding: $scrypt$N=16384,r=8,p=1$<salt_b64>$<key_b64>
function encodeHash(salt: Buffer, key: Buffer, N = SCRYPT_N, r = SCRYPT_r, p = SCRYPT_p): string {
    return `$scrypt$N=${N},r=${r},p=${p}$${b64(salt)}$${b64(key)}`;
}

function parseHash(hash: string): { N: number; r: number; p: number; salt: Buffer; key: Buffer } | null {
    if (!hash.startsWith("$scrypt$")) return null;
    const parts = hash.split("$"); // ['', 'scrypt', 'N=...,r=...,p=...', '<salt>', '<key>']
    if (parts.length !== 5) return null;
    const paramsStr = parts[2];
    const saltB64 = parts[3];
    const keyB64 = parts[4];
    const params: Record<string, string> = Object.create(null);
    for (const kv of paramsStr.split(",")) {
        const [k, v] = kv.split("=");
        if (k && v) params[k] = v;
    }
    const N = Number(params["N"] ?? params["n"]);
    const r = Number(params["r"]);
    const p = Number(params["p"]);
    if (!Number.isFinite(N) || !Number.isFinite(r) || !Number.isFinite(p)) return null;
    try {
        const salt = ub64(saltB64);
        const key = ub64(keyB64);
        return { N, r, p, salt, key };
    } catch {
        return null;
    }
}

export async function hashPassword(pw: string): Promise<string> {
    const salt = crypto.randomBytes(SALT_BYTES);
    const key = await new Promise<Buffer>((resolve, reject) => {
        crypto.scrypt(pw, salt, KEYLEN, { N: SCRYPT_N, r: SCRYPT_r, p: SCRYPT_p }, (err, derivedKey) => {
            if (err) reject(err);
            else resolve(derivedKey as Buffer);
        });
    });
    return encodeHash(salt, key);
}

export async function verifyPassword(hash: string, pw: string): Promise<boolean> {
    try {
        const parsed = parseHash(hash);
        if (!parsed) return false; // not a scrypt hash we recognize
        const { N, r, p, salt, key } = parsed;
        const derived = await new Promise<Buffer>((resolve, reject) => {
            crypto.scrypt(pw, salt, key.length, { N, r, p }, (err, dk) => {
                if (err) reject(err);
                else resolve(dk as Buffer);
            });
        });
        if (derived.length !== key.length) return false;
        return crypto.timingSafeEqual(derived, key);
    } catch {
        return false;
    }
}
