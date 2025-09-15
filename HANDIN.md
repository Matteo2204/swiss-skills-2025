# Skill09App – Hand‑in and Evaluation Notes

## What evaluators need to know
- Platform: Electron app with Angular UI served by embedded Express (in packaged mode).
- Database: External MySQL only. The app expects the SwissSkills VM defaults:
  - Host: `localhost`
  - Port: `3306`
  - User: `root`
  - Password: `ictskills`
  - Database: `ictskills`
- On first launch, the app applies schema (`electron/db/schema.mysql.sql`) and seeds users if missing.

## How to start
- Double‑click the packaged EXE.
- The app starts and connects to MySQL at `localhost:3306` with the above credentials.
- No additional configuration is required.

## Sign‑in
- Seed users (if DB empty):
  - Admin: `admin / admin123`
  - Operator: `operator / operator123`
- “Ricordami” persists the session across restarts. Logout clears it.

## Features overview
- Authentication with Node crypto.scrypt password hashing.
- Items example (list / create / delete) to demonstrate CRUD wiring.
- Sidebar layout with clear navigation, keyboard‑friendly focus states.

## Troubleshooting
- If the app shows DB errors:
  - Verify MySQL is running (VM default installation) and listening on `localhost:3306`.
  - Check that the database `ictskills` is reachable with `root/ictskills`.
- If the schema migration fails once, relaunch the app (it performs a runtime check to add missing columns like `sessions.remember`).

## For the competitor
- Development mirrors the VM defaults; override with env vars if needed:
  - `MYSQL_HOST`, `MYSQL_PORT`, `MYSQL_USER`, `MYSQL_PASSWORD`, `MYSQL_DATABASE`.
- See DESIGN.md for architectural decisions and the full IPC surface.
