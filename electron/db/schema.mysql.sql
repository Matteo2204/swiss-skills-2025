-- electron/db/schema.mysql.sql
-- MySQL schema equivalent for the app

-- Ensure database character set
-- Set at database level when creating DB; here just set session as safety
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

-- items table removed (page and IPC no longer present)
