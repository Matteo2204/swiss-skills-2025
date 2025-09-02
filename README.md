# Skill09App — Angular + Electron + MySQL (Express-served UI)

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
    "copy:schema": "mkdir -p dist/db && cpx \"electron/db/schema.mysql.sql\" dist/db",

    "start": "electron .",

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


---

## Run modes

### Dev (HMR)
- Angular: `http://localhost:4200/`
- Electron loads that URL.
- Database created in a project-local portable folder (see **Data persistence**).

Per l'avvio in dev senza variabili `MYSQL_*`, assicurati di avere i binari:
- `resources/mysql/<piattaforma>/bin/mysqld[.exe]` nel progetto, oppure
- imposta `MYSQL_BUNDLE_URL` (+ opzionale `MYSQL_BUNDLE_SHA256`) per il download al primo avvio, oppure
- usa un server MySQL esterno impostando `MYSQL_*`.

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
│  │  ├─ index.ts            # MySQL adapter + schema/seed + sidecar bootstrap
│  │  ├─ mysql-server.ts     # Portable MySQL sidecar (init/start/stop, logs, download fallback)
│  │  ├─ utils.ts            # Argon2 helpers, etc.
│  │  └─ schema.mysql.sql    # DDL (users table, items, ...)
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
- Avvio automatico DB locale (sidecar) se non sono presenti variabili `MYSQL_*`.
- Schema applicato da `electron/db/schema.mysql.sql` al primo avvio.
- Dati persistenti in `getPortableDataDir()/db/mysql/datadir` (portabile accanto all'eseguibile).
- Utenti seed (se DB vuoto):
    - `admin` / `admin123` (ruolo: ADMIN)
    - `operator` / `operator123` (ruolo: OPERATOR)

### MySQL bundled (consigliato per macOS e Windows)

Per avere un'app completamente portabile (doppio click e funziona offline), includi MySQL dentro la cartella `resources` del progetto prima del packaging o dell'esecuzione in dev.

Struttura richiesta:
- `resources/mysql/darwin-arm64/bin/mysqld` (macOS Apple Silicon)
- `resources/mysql/darwin-x64/bin/mysqld` (macOS Intel)
- `resources/mysql/win32-x64/bin/mysqld.exe` (Windows x64)

Cosa copiare:
- l'intero contenuto dell'archivio ufficiale di MySQL Community Server (bin, lib, share, plugins, ecc.).

Dove scaricare:
- Sito ufficiale MySQL Community Server (8.4 LTS consigliato): https://dev.mysql.com/downloads/mysql/
- macOS: scegli il pacchetto “Generic (tar archive)” per l'architettura corretta.
- Windows: scegli “ZIP Archive (x86, 64-bit)”.

Note:
- Su macOS, imposta il bit eseguibile su `mysqld` (`chmod +x`). Per la miglior compatibilità con Gatekeeper, firma i binari inclusi insieme all'app.
- In packaging, `extraResources` è già configurato per includere `resources/mysql/**` nel bundle.



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
  "files": ["dist/**/*",
    "electron/db/schema.mysql.sql",
    "electron/db/migrate.ts",
    "electron/db/migrations/**/*"],
  "extraResources": [
    {
      "from": "resources/mysql",
      "to": "resources/mysql",
      "filter": ["**/*"]
    }
  ],
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

### Configurazione Database (MySQL)

- Modalità sidecar (predefinita): nessuna variabile richiesta; l'app avvia MySQL locale in automatico se trova `mysqld` in `resources/mysql/<piattaforma>/bin/`.
- Modalità esterna: imposta queste variabili se vuoi usare un server MySQL già esistente:
  - `MYSQL_HOST` (default `localhost`)
  - `MYSQL_PORT` (default `3306`)
  - `MYSQL_USER`
  - `MYSQL_PASSWORD`
  - `MYSQL_DATABASE`

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
