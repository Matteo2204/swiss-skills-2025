import path from "path";
import fs from "fs";
import { app } from "electron";

export function getPortableDataDir(): string {
    const baseDir = app.isPackaged ? path.dirname(app.getPath("exe")) : process.cwd();
    const dataDir = path.join(baseDir, "data");
    if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
    console.log('[db] Portable data directory:', dataDir);
    return dataDir;
}