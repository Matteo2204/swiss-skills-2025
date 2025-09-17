# CONTEXT

## Panorama
Sistema di gestione flotta tosaerba: registrazione/gestione dispositivi, telemetria (batteria, GPS, stato), comandi remoti, import/export, analytics. Focus attuale: backend (Part 1). Frontend (Part 2) userà un backend fornito dalla gara.

## Stack & Vincoli (invarianti)
- UI: Angular 20 (standalone, signals, router), Bootstrap 5 + Bootstrap Icons.
- Desktop: Electron 31; in packaged, Express serve la UI; preload espone `window.api.invoke`.
- DB: MySQL esterno via `mysql2`. Default: host=localhost, port=3306, user=root, password=ictskills, database=ictskills. Override via env: `MYSQL_HOST|PORT|USER|PASSWORD|DATABASE`.
- Auth app: scrypt `s2$<salt_b64>$<hash_b64>`; legacy argon2 migrati on-the-fly. Login → token persistente in `sessions`. Ruoli: ADMIN (CRUD items), OPERATOR (solo list). `requireRole()` centralizzato.
- Build/Run: dev `npm run dev`; build `npm run build`; pack Win `npm run pack:win`. CSP permissiva, fallback SPA, porta 3000 o libera, log statici.
- Vincoli: nessuna dipendenza nativa aggiuntiva; DDL idempotenti; migrazione runtime presente: `sessions.remember`.

## Dati & DB (3NF)
Entità principali (indicative, 3NF):
- `mower` (identità, anagrafica, home coords, vendor/model/serial/firmware, purchase/maintenance).
- `mower_state` (mower_id, ts, state).
- `mower_battery` (mower_id, ts, level).
- `mower_gps` (mower_id, ts, lat, lon).
- `mower_alert` (mower_id, ts_open, ts_close, type, details).
- `mower_action` (mower_id, ts, action, outcome, iin, port).
- `conn_log` (mower_id, ts, event, info). 
Nota: ERD consegnato come `_ERD.*` alla radice.
Vedi ERD: [_ERD.md](_ERD.md).

## Import CSV (legacy)
File legacy “lawnmower_import.csv”: import ‘one-shot’ (manuale/script). Normalizzare formati data/ora e timezone; garantire charset corretto; validare record; adattare allo schema. Reiezione/skip per record invalidi. 

## REST API (sintesi)
- `GET /api/lawnmowers` con filtri equals (`id`, `name`, `vendor`). I campi `current*` usano l’entry più recente.
- `POST /api/lawnmower` crea: default `currentLatitude/Longitude` = home, `currentState` = StationChargingCompleted, `currentBatteryLevel` = 100.
- `GET /api/lawnmower/{id}` dettagli; `PUT /api/lawnmower` update; `DELETE /api/lawnmower/{id}` cancella tutte le entry; 404 se id inesistente.
- `GET /{id}/battery|gps|state/current` → ultima entry; `GET /{id}/battery|gps|state/history?from&to` → serie nel range; 404 se id inesistente.
- Analytics:
  - `GET /{id}/analytics/distance` → somma distanze tra punti GPS (m), opzionale `from/to`.
  - `GET /{id}/analytics/hours` → ore con `state=Mowing`, opzionale `from/to`.
  - `GET /{id}/analytics/efficency` → % per stati; ignora attesa post-charge.
  - `GET /{id}/analytics/energy` → tempi medi ricarica, cicli, max/min, decay %/h non in carica.
- Actions (downlink):
  - `POST /{id}/actions/{start|stop|home|ackerror}` → invio al dispositivo via TCP.

## Protocollo TCP (riassunto operativo)
- Trasporto: TCP; dispositivi distinti per porta.
- Framing: `0xAA` SoF; `LEN` compresso (7-bit big-endian a più byte); `CHK` = two’s-complement su somma 16-bit di tutti gli octet del frame (payload incluso).
- Sessione: handshake Diffie-Hellman autenticato (g=5, p=0xFFFFFFFB, PSK=0xFEED5EED). HMAC su **payload** (esclude il message type). Tip: `HMAC=0xFADEDBED` per bypass (solo testing).
- CalcMAC: hash 32-bit (rolling `h=31*h+octet`) XOR con `key`.
- Comandi: `0x00` heartbeat/echo; `0x01` control (0x00 stop, 0x01 start, 0x02 home); `0x02` ack-error; `0x03` reset blade time.
- Notifiche: status (battery [0.5%], blade time [s], status enum); position (ts Unix, lat/lon float32; 6 cifre significative).
- Timeout: conn=2000ms; in-frame=200ms; response=500ms; retry con stesso IIN.

## Simulatore
- Un processo, più server su porte diverse; UI web per stati/comandi/velocità; supporto corner cases. Collegarsi alle porte configurate.

## Wireframe links
- (Placeholder) Inserire immagini PNG dei wireframe in `./docs/wireframes/` e linkarle qui per ciascuna feature UI quando disponibili.

## Robustezza
- Resilienza a dati inconsistenti, outage backend, azioni utente invalide; UI/BE devono restare reattivi.

## Note build/run
- Dev: `npm run dev`; Build: `npm run build`; Pack Win: `npm run pack:win`. In packaged, Express serve la UI; CSP permissiva; SPA fallback; porta 3000 o libera.
