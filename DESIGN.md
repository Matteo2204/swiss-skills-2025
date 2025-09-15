# Skill09App – Architecture & Decisions

## Competition Context (SwissSkills – Skill 09)
- Target evaluation environment: Windows 10 x64 VM provided by SwissSkills.
- Evaluators will launch a packaged EXE; no manual configuration or installers.
- VM comes with MySQL Community (localhost:3306), user `root`, password `ictskills`, database `ictskills`.
- Also present: SQL Server Express and various developer tools, but this app targets MySQL.
- Internet access may be restricted during evaluation; the app must work offline using the VM’s MySQL.
- Developer workflow: external MySQL (e.g., Docker) mirroring the VM defaults.

## Overview
- **Platform**: Angular + Electron (Express serves UI in built/packaged).
- **Database**: External MySQL only (no embedded sidecar).
- **Transport**: Electron IPC with a minimal preload bridge (invoke-only).
- **Goal**: Zero manual config on SwissSkills VM; predictable dev experience.

## Database
- **Connection**: Always external.
  - Defaults (VM/dev): `host=localhost`, `port=3306`, `user=root`, `password=ictskills`, `database=ictskills`.
  - Override with env: `MYSQL_HOST`, `MYSQL_PORT`, `MYSQL_USER`, `MYSQL_PASSWORD`, `MYSQL_DATABASE`.
- **Schema**: `electron/db/schema.mysql.sql` (idempotent; executor ignores duplicate index/column errors).
- **Auto-ensure DB**: On startup, attempts to create the target database if missing (best effort).

## Authentication & Sessions
- **Login**: `auth:login` verifies credentials (scrypt) and creates a persistent session token in table `sessions`.
- **Sessions table**: `token`, `user_id`, `role`, `created_at`, `remember (TINYINT)`, `expires_at (NULL)`.
- **Remember me**:
  - UI passes `remember` to `auth:login`; server stores `remember=1`.
  - UI stores token+user in `localStorage` only when `remember=true`.
- **Restore on startup**:
  - UI validates any stored token via `auth:me`.
  - If no token in storage, UI asks `auth:last-remembered` and restores the latest `remember=1` session.
- **Logout**: Removes session from DB and in-memory map; clears UI storage.
- **Authorization**: `requireRole()` enforces token presence (in-memory or reloaded from DB) and role checks.

## Startup Flow
1. Electron main calls `initDB()`
   - Connect to external MySQL (env or defaults).
   - Ensure DB exists (best effort), apply schema (DDL executor tolerant to duplicates).
   - Lightweight migration: checks for `sessions.remember`, adds it if missing.
2. Register IPC handlers (`auth`, `items`).
3. Start renderer (Angular dev server or packaged Express).
4. UI bootstraps:
   - Restores token from storage → validates via `auth:me`.
   - Else tries `auth:last-remembered`.

## IPC Surface
- `auth:login` { username, password, remember? } → { ok, token?, user? }
- `auth:logout` { token } → { ok }
- `auth:register` { username, password } → { ok | error }
- `auth:me` { token } → { ok, user? }
- `auth:last-remembered` → { ok, token?, user? }
- `items:list` { token } → { ok, data }
- `items:create` { token, name } → { ok, id? }
- `items:delete` { token, id } → { ok }

## Frontend UI
- **Layout**: Sidebar (left) + main content; no topbar.
- **Sidebar**:
  - Collapsed and expanded states with identical control sizes for consistency.
  - Navigation buttons 40x40, toggle 40x40, avatar 40x40; centered icons.
  - Subtle brand accent (4px) on right edge.
- **Theme**:
  - Primary: `#1C6EA4`, Deep: `#154D71`, Light: `#33A1E0`, Accent: `#FFF9AF`.
  - Applied via CSS variables; Bootstrap remains the base.

## Configuration
- **Env vars** (optional): `MYSQL_HOST`, `MYSQL_PORT`, `MYSQL_USER`, `MYSQL_PASSWORD`, `MYSQL_DATABASE`.
- **No local data directories**: The app no longer writes a portable DB; all persistence is in external MySQL.

## Packaging
- **No sidecar bundling**: Removed extraResources/signing flow for MySQL binaries.
- **Files**: Package includes Electron dist and schema.
- **VM Fit**: Works out-of-the-box on SwissSkills VM (MySQL preinstalled on 3306 with root/ictskills).

## Migration & Compatibility
- **Idempotent schema**: DDL executor ignores `ER_DUP_KEYNAME` (1061) and `ER_DUP_FIELDNAME` (1060).
- **Runtime migration**: Ensures `sessions.remember` exists on older DBs (ALTER TABLE when missing).

## Diagnostics
- **Logs**: Electron main logs connection target and schema path.
- **Common issues**:
  - ER_BAD_FIELD_ERROR on `sessions.remember` → restart once (runtime migration), or run: `ALTER TABLE sessions ADD COLUMN remember TINYINT(1) NOT NULL DEFAULT 0`.
  - Connection refused → confirm MySQL is running on `localhost:3306`.

## Next Steps
- Add `expires_at` handling (e.g., 7d TTL) and cleanup of old sessions.
- Add `.env.example` and optional `dotenv` for local overrides.
- Optional: “Remember me” UX—explicit toggle state restore and visual indicator.
- Optional: Docker compose for dev MySQL with root/ictskills pre-seeded.
- Optional: E2E smoke tests (auth + items CRUD) against a test DB.
