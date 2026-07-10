-- ============================================================
-- Waterlift AI Sales Agent — MySQL Schema
-- Upload via phpMyAdmin: select your database → Import → choose this file
-- ============================================================

-- Dashboard login accounts (hand-rolled auth, no external vendor).
-- Provisioned via scripts/create-admin-user.js — no public signup route.
CREATE TABLE IF NOT EXISTS admin_users (
  id            INT UNSIGNED NOT NULL AUTO_INCREMENT,
  email         VARCHAR(255) NOT NULL,
  password_hash VARCHAR(255) NOT NULL,
  created_at    TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uniq_email (email)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Session store for express-session (via express-mysql-session). Named distinctly
-- from the `sessions` table below, which holds WhatsApp conversation state, not logins.
CREATE TABLE IF NOT EXISTS admin_sessions (
  session_id VARCHAR(128) NOT NULL,
  expires    INT UNSIGNED NOT NULL,
  data       MEDIUMTEXT,
  PRIMARY KEY (session_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS sessions (
  phone          VARCHAR(30)  NOT NULL,
  domain         VARCHAR(20)  DEFAULT NULL,
  last_seen      BIGINT       NOT NULL,
  escalated      TINYINT(1)   NOT NULL DEFAULT 0,
  human_takeover TINYINT(1)   NOT NULL DEFAULT 0,
  ad_referral    TEXT         DEFAULT NULL,
  created_at     TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (phone),
  INDEX idx_last_seen (last_seen)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS messages (
  id             INT UNSIGNED NOT NULL AUTO_INCREMENT,
  phone          VARCHAR(30)  NOT NULL,
  role           VARCHAR(20)  NOT NULL,
  content        LONGTEXT     NOT NULL,
  source         VARCHAR(20)  DEFAULT NULL,
  ts             BIGINT       NOT NULL,
  wa_message_id  VARCHAR(128) DEFAULT NULL,   -- WhatsApp's own id (wamid...) for this message, so other messages can quote-reply to it
  reply_context  TEXT         DEFAULT NULL,   -- JSON snapshot {waMessageId, preview, sender} of the message this one is replying to, if any
  PRIMARY KEY (id),
  INDEX idx_phone_ts (phone, ts, id),
  INDEX idx_wa_message_id (wa_message_id)
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
  notes            TEXT         DEFAULT NULL,
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
