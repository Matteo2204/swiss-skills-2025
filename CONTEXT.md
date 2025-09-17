TODO: Sostituire i percorsi wireframe non appena le immagini sono pronte.

WARNING: Questo file è la fonte di verità. Ogni prompt Codex deve leggerlo prima di eseguire patch.

1) Panorama & Stack (invarianti)
- UI: Angular 20 (renderer). Chiamate REST/SignalR effettuate direttamente dal renderer.
- Desktop: Electron 31 usato solo per packaging; preload espone `window.api.invoke` per bridge I/O file (config/import/export) e null’altro.
- Backend in packaged: Express 5 serve la build Angular; nessuna logica business in Electron.
- DB: MySQL esterno (mysql2). Nessun accesso diretto dal renderer.
- Invarianti: non cambiare stack/build/pipeline/CSP/routing esistenti.

2) Backend runtime (URL, Swagger, Realtime)
- Base URL: http://http://10.211.55.3:3000
- Swagger UI: http://http://10.211.55.3:3000/swagger
- Servizi: LawnmowerAPI (REST) + LawnmowerHub (SignalR).
- Solo HTTP/SignalR: nessun altro trasporto; niente IPC per rete.
- Realtime/polling: usare SignalR per live; se disconnesso, fallback a polling HTTP con intervallo = `RefreshInterval` (config), retry allo stesso intervallo.

3) Feature & AC (sintetiche)
- Cockpit / Device selection
  - Elenco dispositivi ricercabile; selezione persistente; empty/skeleton; gestione 404.
  - Cockpit mostra stato corrente, batteria, posizione, ultimo aggiornamento; aggiornamento live/polling.
- Overview
  - KPI sintetici (stato, batteria, ultima posizione, messaggi non letti); azioni rapide.
- Battery trend
  - Grafico lineare su intervallo selezionato; tooltip; empty; range vincolato a `LiveRange`/`HistoryRange`.
- Status distribution + timeline
  - Distribuzione percentuale per stato + timeline stacked; stesso range del trend; legenda accessibile.
- Map
  - Posizione corrente + traccia storico; centratura su device selezionato; cluster su zoom.
- Messages (regole 1–6)
  1) Ordine: decrescente per timestamp; caricamento incrementale su scroll.
  2) Severità con badge: INFO/NOTICE/WARN/ERROR; colori coerenti e accessibili.
  3) Filtri: per device, severità, testo; filtro persistente per sessione.
  4) Ack errori: gli ERROR non confermati restano evidenti finché ack (azione esplicita).
  5) Live: stream via SignalR; incremento contatore “nuovi”; fallback a polling.
  6) Limiti: mantenere in memoria max N elementi (es. 500); oltre, paginate lato server.
- Remote control
  - Azioni START/STOP/HOME/ACK ERROR con conferma; pre-check con ping; stato comando (in corso/esito).
- Import
  - Import batteria/GPS/stato tramite upload; validazioni base; progress e report errori.
- Export
  - Esporta dati correnti/filtrati su file locale via bridge Electron (nessun endpoint REST dedicato).
- Config
  - Pagina impostazioni con salvataggio e reset; applicare subito RefreshInterval/fallback.
- Connection handling
  - Indicatori connesso/disconnesso; retry a `RefreshInterval`; banner degrado a polling; toast su errori 4xx/5xx.

4) Wireframes (placeholder finché non presenti in repo)

| Feature                          | File wireframe (docs/wireframes/...)              |
|----------------------------------|--------------------------------------------------|
| Cockpit                          | docs/wireframes/cockpit.png                      |
| Device selection                 | docs/wireframes/device-selection.png             |
| Map                              | docs/wireframes/map.png                          |
| Battery trend                    | docs/wireframes/battery-trend.png                |
| Status distribution + timeline   | docs/wireframes/status-distribution-timeline.png |
| Messages                         | docs/wireframes/messages.png                     |
| Remote control                   | docs/wireframes/remote-control.png               |
| Import                           | docs/wireframes/import-dialog.png                |
| Export                           | docs/wireframes/export-dialog.png                |

5) Endpoint REST (percorsi e metodi esatti)
- GET/POST /api/lawnmowers
- GET/PUT/DELETE /api/lawnmowers/{id}
- GET/POST/DELETE /api/lawnmowers/{id}/avatar (POST multipart PNG/JPEG/BMP)
- GET /api/lawnmowers/{id}/battery/current
- GET /api/lawnmowers/{id}/battery/history?from&to
- POST /api/lawnmowers/{id}/battery/import
- GET /api/lawnmowers/{id}/gps/current
- GET /api/lawnmowers/{id}/gps/history?from&to
- POST /api/lawnmowers/{id}/gps/import
- GET /api/lawnmowers/{id}/state/current
- GET /api/lawnmowers/{id}/state/history?from&to
- POST /api/lawnmowers/{id}/state/import
- GET /api/lawnmowers/{id}/remote-control/ping
- POST /api/lawnmowers/{id}/remote-control/action/{action} con action ∈ {0:START,1:STOP,2:HOME,3:ACK ERROR}

6) Config file (accanto all’EXE)
- Nome: “<ExecutableName>.config”. Formato semplice key=value (interpretazione a carico dell’app).
- Chiavi supportate (default e range):
  - DefaultView: default=cockpit; valori ammessi=cockpit|overview|map|messages|remote-control.
  - LiveRange (minuti): default=15; range=[1,120].
  - HistoryRange (ore): default=24; range=[1,720] (max 30 giorni).
  - BatteryLowThreshold (%): default=20; range=[5,50].
  - StuckThreshold (minuti): default=5; range=[1,60].
  - RefreshInterval (ms): default=3000; range=[1000,60000].

7) Principi di integrazione
- REST dirette dal renderer Angular verso Base URL; nessun proxy IPC per rete.
- SignalR (LawnmowerHub) per live; fallback polling secondo `RefreshInterval`.
- Electron solo per packaging + bridge I/O file (config/import/export) via `window.api.invoke`.
- MySQL esterno: gestito dal backend; nessun accesso dal renderer.

Assunzione minima (non invasiva): Export file eseguito localmente via bridge Electron; nessun endpoint dedicato richiesto in Part 2.

Nota implementativa (UI cockpit – device selection):
- Component aggiunto: `DeviceSelectorComponent` (standalone, OnPush) in `app/src/app/shared/device-selector/`.
- Segnale globale: `DeviceSelectionService.selected: signal<LawnmowerResponse|null>` in `app/src/app/shared/services/` (usare `hasSelection()` per abilitare/disabled azioni cockpit).
- Avatar: cache in‑memory tramite `AvatarCacheService` per evitare richieste ripetute; fallback icona quando assente.
