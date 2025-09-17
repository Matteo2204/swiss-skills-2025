# Entity-Relationship Diagram (Mermaid)

Assunzione: nessun wireframe presente in `./docs/wireframes/` al momento; ERD basato esclusivamente su `electron/db/schema.mysql.sql` v1.

```mermaid
erDiagram
  APP_META {
    VARCHAR(191) key PK
    TEXT value
  }

  USERS {
    BIGINT id PK
    VARCHAR(191) username UNIQUE
    VARCHAR(255) password_hash
    ENUM role
    TIMESTAMP created_at
  }

  SESSIONS {
    VARCHAR(191) token PK
    BIGINT user_id FK
    ENUM role
    TIMESTAMP created_at
    TINYINT(1) remember
    TIMESTAMP expires_at
  }

  ITEMS {
    BIGINT id PK
    VARCHAR(255) name
    TIMESTAMP created_at
  }

  MOWER {
    BIGINT id PK
    VARCHAR(120) name UNIQUE
    VARCHAR(80) vendor
    VARCHAR(80) model
    VARCHAR(120) serial_number
    VARCHAR(80) firmware
    DECIMAL(9,6) home_lat
    DECIMAL(9,6) home_lon
    TIMESTAMP created_at
    TIMESTAMP updated_at
  }

  MOWER_STATE {
    BIGINT id PK
    BIGINT mower_id FK
    DATETIME(3) ts
    VARCHAR(48) state
  }

  MOWER_BATTERY {
    BIGINT id PK
    BIGINT mower_id FK
    DATETIME(3) ts
    DECIMAL(4,1) level
  }

  MOWER_GPS {
    BIGINT id PK
    BIGINT mower_id FK
    DATETIME(3) ts
    DECIMAL(9,6) lat
    DECIMAL(9,6) lon
  }

  MOWER_ALERT {
    BIGINT id PK
    BIGINT mower_id FK
    DATETIME(3) ts_open
    DATETIME(3) ts_close
    VARCHAR(48) type
    VARCHAR(255) details
  }

  MOWER_ACTION {
    BIGINT id PK
    BIGINT mower_id FK
    DATETIME(3) ts
    VARCHAR(24) action
    VARCHAR(16) outcome
    INT iin
    INT port
  }

  CONN_LOG {
    BIGINT id PK
    BIGINT mower_id FK
    DATETIME(3) ts
    VARCHAR(32) event
    VARCHAR(255) info
    INT port
  }

  USERS ||--o{ SESSIONS : "user_id (CASCADE)"
  MOWER ||--o{ MOWER_STATE : "mower_id (CASCADE)"
  MOWER ||--o{ MOWER_BATTERY : "mower_id (CASCADE)"
  MOWER ||--o{ MOWER_GPS : "mower_id (CASCADE)"
  MOWER ||--o{ MOWER_ALERT : "mower_id (CASCADE)"
  MOWER ||--o{ MOWER_ACTION : "mower_id (CASCADE)"
  MOWER ||--o{ CONN_LOG : "mower_id (SET NULL)"
```

Note
- Vincoli univoci (selezione): `mower.name` UNIQUE; molte tabelle storiche hanno UNIQUE su `(mower_id, ts)` (non rappresentato graficamente).
- FK e azioni ON DELETE:
  - `sessions.user_id` → `users.id` ON DELETE CASCADE.
  - `mower_*.*.mower_id` → `mower.id` ON DELETE CASCADE.
  - `conn_log.mower_id` → `mower.id` ON DELETE SET NULL (FK opzionale).
