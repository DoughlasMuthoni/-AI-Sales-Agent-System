-- ============================================================
-- Waterlift AI Sales Agent — MySQL Schema
-- Upload via phpMyAdmin: select your database → Import → choose this file
-- ============================================================

CREATE TABLE IF NOT EXISTS sessions (
  phone          VARCHAR(30)  NOT NULL,
  domain         VARCHAR(20)  DEFAULT NULL,
  last_seen      BIGINT       NOT NULL,
  escalated      TINYINT(1)   NOT NULL DEFAULT 0,
  human_takeover TINYINT(1)   NOT NULL DEFAULT 0,
  created_at     TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (phone),
  INDEX idx_last_seen (last_seen)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS messages (
  id      INT UNSIGNED NOT NULL AUTO_INCREMENT,
  phone   VARCHAR(30)  NOT NULL,
  role    VARCHAR(20)  NOT NULL,
  content LONGTEXT     NOT NULL,
  source  VARCHAR(20)  DEFAULT NULL,
  ts      BIGINT       NOT NULL,
  PRIMARY KEY (id),
  INDEX idx_phone_ts (phone, ts, id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS leads (
  id               INT UNSIGNED NOT NULL AUTO_INCREMENT,
  name             VARCHAR(255) DEFAULT NULL,
  phone            VARCHAR(30)  DEFAULT NULL,
  location         VARCHAR(255) DEFAULT NULL,
  service          VARCHAR(20)  DEFAULT NULL,
  property_type    VARCHAR(100) DEFAULT NULL,
  estimated_budget VARCHAR(100) DEFAULT NULL,
  status           VARCHAR(20)  NOT NULL DEFAULT 'new',
  captured_at      DATETIME     NOT NULL,
  status_updated_at DATETIME    DEFAULT NULL,
  PRIMARY KEY (id),
  INDEX idx_captured_at (captured_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS callbacks (
  id             INT UNSIGNED NOT NULL AUTO_INCREMENT,
  name           VARCHAR(255) DEFAULT NULL,
  phone          VARCHAR(30)  DEFAULT NULL,
  preferred_date VARCHAR(100) DEFAULT NULL,
  preferred_time VARCHAR(100) DEFAULT NULL,
  notes          TEXT         DEFAULT NULL,
  booked_at      DATETIME     NOT NULL,
  PRIMARY KEY (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS escalations (
  id            INT UNSIGNED NOT NULL AUTO_INCREMENT,
  customer_name VARCHAR(255) DEFAULT NULL,
  urgency       VARCHAR(20)  DEFAULT NULL,
  reason        TEXT         DEFAULT NULL,
  escalated_at  DATETIME     NOT NULL,
  PRIMARY KEY (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Browser push subscriptions for the admin dashboard (one row per installed device)
CREATE TABLE IF NOT EXISTS push_subscriptions (
  id            INT UNSIGNED NOT NULL AUTO_INCREMENT,
  endpoint      TEXT         NOT NULL,
  endpoint_hash CHAR(64)     NOT NULL,
  p256dh        VARCHAR(255) NOT NULL,
  auth          VARCHAR(255) NOT NULL,
  created_at    TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uniq_endpoint_hash (endpoint_hash)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
