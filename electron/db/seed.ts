import { initDB, getDB } from "./index";
import { hashPassword } from "./utils";

async function seed() {
    // Esegue migrazione/inizializzazione e apre il DB in ./data/app.db (portable)
    await initDB();
    const db = getDB();

    // --- Utenti demo ---
    const rowU = await db.prepare("SELECT COUNT(*) as c FROM users").get() as { c: number };
    const userCount = Number((rowU as any)?.c ?? 0);
    if (userCount === 0) {
        const insertUser = db.prepare("INSERT INTO users (username, password_hash, role) VALUES (?,?,?)");
        await insertUser.run("admin", await hashPassword("admin123"), "ADMIN");
        await insertUser.run("operator", await hashPassword("operator123"), "OPERATOR");
        console.log("👤 Users seeded: admin/admin123, operator/operator123");
    }

    // --- Dati esempio per 'items' (opzionale) ---
    const rowI = await db.prepare("SELECT COUNT(*) as c FROM items").get() as { c: number };
    const itemCount = Number((rowI as any)?.c ?? 0);
    if (itemCount === 0) {
        const ins = db.prepare("INSERT INTO items (name) VALUES (?)");
        for (const n of ["Demo item A", "Demo item B", "Demo item C"]) {
            await ins.run(n);
        }
        console.log("📦 Items seeded");
    }

    console.log("✅ Seed complete");
}

seed().catch(err => { console.error(err); process.exit(1); });
