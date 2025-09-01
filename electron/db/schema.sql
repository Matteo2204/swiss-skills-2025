BEGIN;

CREATE TABLE IF NOT EXISTS app_meta (
                                        key   TEXT PRIMARY KEY,
                                        value TEXT NOT NULL
);
INSERT OR IGNORE INTO app_meta(key,value) VALUES ('schema_version','1');

CREATE TABLE IF NOT EXISTS users (
                                     id INTEGER PRIMARY KEY AUTOINCREMENT,
                                     username TEXT UNIQUE NOT NULL,
                                     password_hash TEXT NOT NULL,
                                     role TEXT NOT NULL CHECK (role IN ('ADMIN','OPERATOR')),
                                     created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS items (
                                     id INTEGER PRIMARY KEY AUTOINCREMENT,
                                     name TEXT NOT NULL,
                                     created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_items_created ON items(created_at);

COMMIT;