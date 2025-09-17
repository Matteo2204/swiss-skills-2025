-- electron/db/schema.mysql.sql
-- MySQL schema equivalent for the app

SET NAMES utf8mb4;
SET SESSION sql_mode = 'STRICT_TRANS_TABLES,NO_ENGINE_SUBSTITUTION';

-- app_meta table
CREATE TABLE IF NOT EXISTS app_meta (
  `key`   VARCHAR(191) PRIMARY KEY,
  `value` TEXT NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

INSERT INTO app_meta(`key`,`value`) VALUES ('schema_version','1')
  ON DUPLICATE KEY UPDATE `value` = VALUES(`value`);

-- users table
CREATE TABLE IF NOT EXISTS users (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  username VARCHAR(191) NOT NULL UNIQUE,
  password_hash VARCHAR(255) NOT NULL,
  role ENUM('ADMIN','OPERATOR') NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- persistent sessions (so tokens survive app restarts)
CREATE TABLE IF NOT EXISTS sessions (
  token VARCHAR(191) NOT NULL PRIMARY KEY,
  user_id BIGINT UNSIGNED NOT NULL,
  role ENUM('ADMIN','OPERATOR') NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  remember TINYINT(1) NOT NULL DEFAULT 0,
  expires_at TIMESTAMP NULL DEFAULT NULL,
  CONSTRAINT fk_sessions_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
CREATE INDEX idx_sessions_user ON sessions(user_id);

-- items table
CREATE TABLE IF NOT EXISTS items (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  name VARCHAR(255) NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE INDEX idx_items_created ON items(created_at);

-- =========
-- LawnMower Schema v1
-- =========
-- Engine/collation coerenti con baseline
SET @saved_sql_notes = @@sql_notes;
SET sql_notes = 0;

CREATE TABLE IF NOT EXISTS `mower` (
  `id`            BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `name`          VARCHAR(120)    NOT NULL,
  `vendor`        VARCHAR(80)     NULL,
  `model`         VARCHAR(80)     NULL,
  `serial_number` VARCHAR(120)    NULL,
  `firmware`      VARCHAR(80)     NULL,
  `home_lat`      DECIMAL(9,6)    NULL,
  `home_lon`      DECIMAL(9,6)    NULL,
  `created_at`    TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at`    TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_mower_name` (`name`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS `mower_state` (
  `id`       BIGINT UNSIGNED  NOT NULL AUTO_INCREMENT,
  `mower_id` BIGINT UNSIGNED  NOT NULL,
  `ts`       DATETIME(3)      NOT NULL,
  `state`    VARCHAR(48)      NOT NULL, -- es. Mowing, StationChargingCompleted, Stuck, ecc.
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_mower_state_ts` (`mower_id`, `ts`),
  KEY `idx_mower_state_state` (`state`),
  KEY `idx_mower_state_mower_ts` (`mower_id`, `ts`),
  CONSTRAINT `fk_mower_state_mower` FOREIGN KEY (`mower_id`) REFERENCES `mower`(`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS `mower_battery` (
  `id`       BIGINT UNSIGNED  NOT NULL AUTO_INCREMENT,
  `mower_id` BIGINT UNSIGNED  NOT NULL,
  `ts`       DATETIME(3)      NOT NULL,
  `level`    DECIMAL(4,1)     NOT NULL, -- 0.0 .. 100.0 (incrementi di 0.5 ok)
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_mower_battery_ts` (`mower_id`, `ts`),
  KEY `idx_mower_battery_mower_ts` (`mower_id`, `ts`),
  CONSTRAINT `fk_mower_battery_mower` FOREIGN KEY (`mower_id`) REFERENCES `mower`(`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS `mower_gps` (
  `id`       BIGINT UNSIGNED  NOT NULL AUTO_INCREMENT,
  `mower_id` BIGINT UNSIGNED  NOT NULL,
  `ts`       DATETIME(3)      NOT NULL,
  `lat`      DECIMAL(9,6)     NOT NULL,
  `lon`      DECIMAL(9,6)     NOT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_mower_gps_ts` (`mower_id`, `ts`),
  KEY `idx_mower_gps_mower_ts` (`mower_id`, `ts`),
  KEY `idx_mower_gps_lat_lon` (`lat`,`lon`),
  CONSTRAINT `fk_mower_gps_mower` FOREIGN KEY (`mower_id`) REFERENCES `mower`(`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS `mower_alert` (
  `id`        BIGINT UNSIGNED  NOT NULL AUTO_INCREMENT,
  `mower_id`  BIGINT UNSIGNED  NOT NULL,
  `ts_open`   DATETIME(3)      NOT NULL,
  `ts_close`  DATETIME(3)      NULL,
  `type`      VARCHAR(48)      NOT NULL, -- es. BladeWorn, Obstacle, LowBattery, ecc.
  `details`   VARCHAR(255)     NULL,
  PRIMARY KEY (`id`),
  KEY `idx_mower_alert_open` (`mower_id`,`ts_open`),
  KEY `idx_mower_alert_close` (`mower_id`,`ts_close`),
  KEY `idx_mower_alert_type` (`type`),
  CONSTRAINT `fk_mower_alert_mower` FOREIGN KEY (`mower_id`) REFERENCES `mower`(`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS `mower_action` (
  `id`        BIGINT UNSIGNED  NOT NULL AUTO_INCREMENT,
  `mower_id`  BIGINT UNSIGNED  NOT NULL,
  `ts`        DATETIME(3)      NOT NULL,
  `action`    VARCHAR(24)      NOT NULL, -- start|stop|home|ackerror|resetblade
  `outcome`   VARCHAR(16)      NULL,     -- queued|sent|ack|error
  `iin`       INT UNSIGNED     NULL,     -- correlation id
  `port`      INT UNSIGNED     NULL,     -- porta TCP del dispositivo
  PRIMARY KEY (`id`),
  KEY `idx_mower_action_mower_ts` (`mower_id`, `ts`),
  KEY `idx_mower_action_action` (`action`),
  CONSTRAINT `fk_mower_action_mower` FOREIGN KEY (`mower_id`) REFERENCES `mower`(`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS `conn_log` (
  `id`        BIGINT UNSIGNED  NOT NULL AUTO_INCREMENT,
  `mower_id`  BIGINT UNSIGNED  NULL,
  `ts`        DATETIME(3)      NOT NULL,
  `event`     VARCHAR(32)      NOT NULL, -- connect|disconnect|timeout|retry|auth_ok|auth_fail|heartbeat
  `info`      VARCHAR(255)     NULL,
  `port`      INT UNSIGNED     NULL,
  PRIMARY KEY (`id`),
  KEY `idx_conn_log_mower_ts` (`mower_id`, `ts`),
  KEY `idx_conn_log_event` (`event`),
  CONSTRAINT `fk_conn_log_mower` FOREIGN KEY (`mower_id`) REFERENCES `mower`(`id`) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- === Helper views per "current*" ===
CREATE OR REPLACE VIEW `v_mower_latest_state` AS
SELECT s.* FROM `mower_state` s
JOIN (SELECT mower_id, MAX(ts) AS ts FROM `mower_state` GROUP BY mower_id) mx
  ON mx.mower_id = s.mower_id AND mx.ts = s.ts;

CREATE OR REPLACE VIEW `v_mower_latest_battery` AS
SELECT b.* FROM `mower_battery` b
JOIN (SELECT mower_id, MAX(ts) AS ts FROM `mower_battery` GROUP BY mower_id) mx
  ON mx.mower_id = b.mower_id AND mx.ts = b.ts;

CREATE OR REPLACE VIEW `v_mower_latest_gps` AS
SELECT g.* FROM `mower_gps` g
JOIN (SELECT mower_id, MAX(ts) AS ts FROM `mower_gps` GROUP BY mower_id) mx
  ON mx.mower_id = g.mower_id AND mx.ts = g.ts;

CREATE OR REPLACE VIEW `v_mower_current` AS
SELECT
  m.id                AS mower_id,
  m.name,
  m.vendor,
  m.model,
  m.serial_number,
  m.firmware,
  m.home_lat,
  m.home_lon,
  ls.`state`          AS currentState,
  lb.`level`          AS currentBatteryLevel,
  lg.`lat`            AS currentLatitude,
  lg.`lon`            AS currentLongitude,
  GREATEST(
    COALESCE(ls.ts, '1970-01-01'),
    COALESCE(lb.ts, '1970-01-01'),
    COALESCE(lg.ts, '1970-01-01')
  ) AS currentTs
FROM `mower` m
LEFT JOIN `v_mower_latest_state`   ls ON ls.mower_id = m.id
LEFT JOIN `v_mower_latest_battery` lb ON lb.mower_id = m.id
LEFT JOIN `v_mower_latest_gps`     lg ON lg.mower_id = m.id;

SET sql_notes = @saved_sql_notes;
-- ========= Fine LawnMower Schema v1 =========
