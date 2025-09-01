# Skill09App — Angular + Electron + SQLite (Express-served UI)

Desktop app scaffold used for **SwissSkills – Skill 09 (Informatics)**.  
Tech stack:

- **Frontend**: Angular 20
- **Desktop wrapper**: Electron 31
- **Database**: MySQL (via `mysql2`)
- **Auth**: Argon2 password hashing + in-memory sessions
- **Local server**: Express 5 (serves the Angular build in packaged mode)
- **Packaging**: electron-builder (DMG on macOS, ZIP on Windows)

---

## Quick start

```bash
# 1) Install deps (root + Angular app)
npm install

# 2) Dev mode — Angular HMR + Electron
npm run dev
```

In dev, **work inside the Electron window**, not the browser tab.  
Open DevTools (⌥⌘I on macOS) and check:
```js
typeof window.api === "object"   // should be true (preload bridge)
```

---

## Scripts (root `package.json`)

```json
{
  "scripts": {
    "dev": "concurrently -k -n ANG,TSC,ELEC \"npm run dev:angular\" \"npm run build:electron:watch\" \"npm run run:electron\"",
    "dev:angular": "npm --prefix app run start -- --port 4200 --open=false",
    "build:electron:watch": "tsc -p tsconfig.json -w",
    "run:electron": "wait-on dist/main.js http://localhost:4200 && nodemon --verbose --watch dist --ext js --exec \"electron .\"",

    "build": "npm run build:angular && npm run build:electron && npm run copy:ui && npm run copy:schema",
    "build:angular": "npm --prefix app run build",
    "build:electron": "tsc -p tsconfig.json",
    "copy:ui": "mkdir -p dist/ui && cpx \"app/dist/app/browser/**/*\" dist/ui",
    "copy:schema": "mkdir -p dist/db && cpx \"electron/db/schema.sql\" dist/db",

    "start": "electron .",

    "deps:rebuild": "electron-rebuild -f -w better-sqlite3 --runtime=electron --version=31.7.7",
    "postinstall": "electron-builder install-app-deps",

    "pack:mac": "electron-builder --projectDir . --mac dmg",
    "pack:win": "electron-builder --projectDir . --win zip --x64"
  }
}
```

- `dev` → runs Angular dev server (port 4200), TypeScript watch for Electron, and launches Electron.
- `build` → Angular production build → copies UI to `dist/ui` → compiles Electron TS → copies DB schema.
- `start` → runs Electron against the **built** app (serves UI with Express).
- `pack:*` → packages the app (outputs in `release/`).
- `deps:rebuild` → rebuild native modules (use if you change Electron version).

---

## Run modes

### Dev (HMR)
- Angular: `http://localhost:4200/`
- Electron loads that URL.
- Database created in a project-local portable folder (see **Data persistence**).

Start:
```bash
npm run dev
```

### Built (no packaging)
- Angular static files are copied to `dist/ui`.
- Electron starts **Express** and loads `http://127.0.0.1:<dynamicPort>/`.

Build & run:
```bash
npm run build
npm start
```

### Packaged
- Electron app starts **Express** inside the app and loads the served URL.
- **macOS (DMG)**:
  ```bash
  npm run pack:mac
  open release/Skill09App-<version>-arm64.dmg
  ```
- **Windows (ZIP)**:
  ```bash
  npm run pack:win
  ```

> Tip (macOS): to see console logs of the packaged app, run:
> ```bash
> "/path/to/release/mac-arm64/Skill09App.app/Contents/MacOS/Skill09App"
> ```

---

## Project structure

```
.
├─ app/                      # Angular project (Angular 20)
│  └─ dist/app/browser       # Angular build output (prod)
├─ electron/                 # Electron sources (TypeScript)
│  ├─ main.ts                # Electron entrypoint
│  ├─ preload.ts             # Secure bridge: window.api.invoke(...)
│  ├─ server.ts              # Express 5 server (serves UI in built/packaged)
│  ├─ db/
│  │  ├─ index.ts            # SQLite init, PRAGMA, migrations (schema.sql)
│  │  ├─ utils.ts            # Argon2 helpers, etc.
│  │  └─ schema.sql          # DDL (users table, items, ...)
│  └─ ipc/
│     └─ auth.ts             # IPC handlers: 'auth:login', 'auth:logout'
├─ dist/                     # Compiled Electron + copied UI
│  ├─ main.js, preload.js, server.js, ...
│  └─ ui/                    # Copied Angular build (served by Express)
├─ release/                  # Packaged artifacts (DMG/ZIP)
├─ package.json
├─ tsconfig.json             # TS config for Electron sources
└─ README.md
```

---

## Preload bridge (renderer API)

`electron/preload.ts` exposes a typed, minimal API:

```ts
type Channel =
  | "auth:login" | "auth:logout"
  | "items:list" | "items:create" | "items:delete";

contextBridge.exposeInMainWorld("api", {
  invoke: (channel: Channel, payload?: any) => ipcRenderer.invoke(channel, payload)
});
```

Use it from Angular:
```ts
const res = await window.api!.invoke('auth:login', { username, password });
```

Security defaults in `BrowserWindow`:
- `contextIsolation: true`
- `nodeIntegration: false`
- `sandbox: true`

---

## IPC channels (example)

- `auth:login` → `{ username, password }` → `{ ok, token?, user? }`
- `auth:logout` → `{ token? }` → `{ ok }`
- `items:list`, `items:create`, `items:delete` → (example CRUD; adjust to your entities)

Handlers are registered early in `main.ts` **before** any `loadURL()`.

---

## Database & data persistence

- Engine: **MySQL**, driver **mysql2**.
- Schema is applied from `electron/db/schema.mysql.sql` on first launch.
- Configure via env vars (`MYSQL_HOST`, `MYSQL_PORT`, `MYSQL_USER`, `MYSQL_PASSWORD`, `MYSQL_DATABASE`).
- Seed users (example):
    - `admin` / `admin123` (role: ADMIN)
    - `operator` / `operator123` (role: OPERATOR)



---

## Express server (built/packaged)

We **always** serve the Angular UI via Express in non-dev modes to avoid `file://` issues.

Key points in `electron/server.ts`:

- Express **5** SPA fallback:
  ```ts
  app.get(/.*/, (_req, res) => res.sendFile(path.join(staticRoot, "index.html")));
  ```
  (Do **not** use `"*"` with Express 5.)
- Robust port selection:
    - try `preferredPort` (3000), fallback to `0` (OS assigns a free port).
- `createExpressServer()` returns `{ url, server }` so `main.ts` can `loadURL(url)` and close the server on exit.

---

## Packaging configuration (electron-builder)

`package.json`:

```json
"build": {
  "appId": "com.galassini.skill09",
  "productName": "Skill09App",
  "directories": { "app": ".", "output": "release" },
  "files": ["dist/**/*"],
  "asarUnpack": ["**/*.node"],
  "mac": { "target": ["dmg", "zip"] },
  "win": { "target": ["zip"] },
  "dmg": {
    "title": "Skill09App-${version}-${arch}",
    "artifactName": "Skill09App-${version}-${arch}.${ext}"
  }
}
```

> Note: recent electron-builder uses `dmg.title` (not `volumeName`).

---

## Troubleshooting

### Blank/No window on packaged app
1. Run the app from Terminal to see logs:
   ```bash
   "/path/to/release/mac-arm64/Skill09App.app/Contents/MacOS/Skill09App"
   ```
2. You should see logs like:
   ```
   [server] Express listening on http://127.0.0.1:<PORT> (root: .../ui)
   [main] PACKAGED → http://127.0.0.1:<PORT>
   [main] did-finish-load
   ```
3. If you see `pathToRegexp` errors → ensure `server.ts` uses `app.get(/.*/, ...)`.

### Port 3000 in use
```bash
lsof -ti :3000 | xargs kill -9
```

### DMG build fails with `hdiutil detach ... code 16`
A volume is busy. Detach mounted volumes and retry:
```bash
hdiutil info | sed -n '1,200p'
hdiutil detach -force /dev/diskN   # replace N accordingly
```
For quicker testing:
```bash
npx electron-builder --mac zip
```

### Database Configuration (MySQL)

- Set the following environment variables before running the app:
  - `MYSQL_HOST` (default `localhost`)
  - `MYSQL_PORT` (default `3306`)
  - `MYSQL_USER`
  - `MYSQL_PASSWORD` (optional if user has no password)
  - `MYSQL_DATABASE`

- On startup, the app creates the database if missing and applies `electron/db/schema.mysql.sql`.

### Data Migration from SQLite

If you already have local data in `./data/app.db` (SQLite), migrate it with:

```
MYSQL_HOST=localhost MYSQL_USER=root MYSQL_PASSWORD=secret MYSQL_DATABASE=skill09 npm run db:migrate:data
```

Optional: set `SQLITE_PATH` to point to a custom `.db` file.

### Native modules mismatch (argon2)
If you change Electron version:
```bash
npm run deps:rebuild
```

### “No handler registered for 'auth:login'”
- Call `registerAuthHandlers()` **before** `loadURL()` in `main.ts`.
- Interact in the **Electron window**, not a browser tab.
- Ensure the preload path is correct: `preload: path.join(__dirname, "preload.js")`.

---

## Version matrix (tested)

- Node.js: 20.x / 22.x
- Electron: 31.7.x
- Angular: 20.x
- Express: 5.x
- mysql2: 3.x
- Argon2: 0.41.x

---

## Security notes

- `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`.
- Minimal `window.api` (only `invoke`).
- Basic CSP is set in Express. Adjust if you add external requests.

---

## Build flow (summary)

1) **Dev**: HMR (`ng serve`) → Electron loads `http://localhost:4200`.
2) **Build**: `ng build` → copy to `dist/ui` → compile Electron TS.
3) **Run built**: Electron starts Express → loads `http://127.0.0.1:<port>`.
4) **Package**: electron-builder creates DMG/ZIP including `dist/**/*`.
