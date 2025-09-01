import { initDB, getDB } from "./index";
import { hashPassword } from "./utils";

async function seed() {
    // Esegue migrazione/inizializzazione e apre il DB in ./data/app.db (portable)
    await initDB();
    const db = getDB();

    // --- Utenti demo ---
    const { c: userCount } = db.prepare("SELECT COUNT(*) as c FROM users").get() as { c: number };
    if (userCount === 0) {
        const insertUser = db.prepare("INSERT INTO users (username, password_hash, role) VALUES (?,?,?)");
        insertUser.run("admin", await hashPassword("admin123"), "ADMIN");
        insertUser.run("operator", await hashPassword("operator123"), "OPERATOR");
        console.log("👤 Users seeded: admin/admin123, operator/operator123");
    }

    // --- Dati esempio per 'items' (opzionale) ---
    const { c: itemCount } = db.prepare("SELECT COUNT(*) as c FROM items").get() as { c: number };
    if (itemCount === 0) {
        const ins = db.prepare("INSERT INTO items (name) VALUES (?)");
        const tx = db.transaction((names: string[]) => { for (const n of names) ins.run(n); });
        tx(["Demo item A", "Demo item B", "Demo item C"]);
        console.log("📦 Items seeded");
    }

    console.log("✅ Seed complete");
}

seed().catch(err => { console.error(err); process.exit(1); });