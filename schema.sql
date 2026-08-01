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

-- Permanently-blocked customer phone numbers — a dedicated table rather than a column on
-- `sessions` below, since that table already exists in production and this project's schema
-- changes have always been additive new tables (avoids needing an ALTER TABLE migration step).
-- Presence of a row = blocked; pipeline.js checks this before running the agentic loop and
-- still logs the customer's message either way, it just never gets an AI reply.
CREATE TABLE IF NOT EXISTS blocked_numbers (
  phone      VARCHAR(30)  NOT NULL,
  reason     VARCHAR(255) DEFAULT NULL,
  blocked_at TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (phone)
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

-- Small key/value store for admin-configurable settings (e.g. the product catalog feed URL)
CREATE TABLE IF NOT EXISTS app_settings (
  setting_key   VARCHAR(100) NOT NULL,
  setting_value TEXT         DEFAULT NULL,
  updated_at    TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (setting_key)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Product catalog, synced from the Meta/WooCommerce feed — replaces the old hardcoded
-- price list in prompts.js so Claude looks up current prices instead of memorizing them
CREATE TABLE IF NOT EXISTS products (
  id           INT UNSIGNED  NOT NULL AUTO_INCREMENT,
  retailer_id  VARCHAR(50)   NOT NULL,   -- Meta catalog product_retailer_id, used by show_products
  name         VARCHAR(255)  NOT NULL,
  description  TEXT          DEFAULT NULL,
  price        DECIMAL(12,2) NOT NULL,
  currency     VARCHAR(10)   NOT NULL DEFAULT 'KES',
  category     VARCHAR(150)  DEFAULT NULL,  -- raw category from the feed, e.g. "Heat Pumps"
  vertical     VARCHAR(50)   DEFAULT NULL,  -- optional tag for future multi-niche filtering, e.g. "solar"/"borehole"
  availability VARCHAR(50)   DEFAULT NULL,
  updated_at   TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uniq_retailer_id (retailer_id),
  INDEX idx_vertical (vertical),
  FULLTEXT INDEX ft_name_category (name, category)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Elevated steel water tower pricing — admin-editable via the dashboard, replacing the
-- hardcoded TOWER_PACKAGES/TOWER_TANK_PRICES/TOWER_FOUNDATION_PRICES constants that used to
-- live in mcpServer.js. Towers are a custom product line, not part of the WooCommerce/Meta
-- feed that syncs `products` above, so they need their own admin-editable pricing.

CREATE TABLE IF NOT EXISTS tower_foundation_prices (
  foundation_type VARCHAR(10)   NOT NULL,   -- 'pad' or 'raft'
  price           DECIMAL(12,2) NOT NULL,
  updated_at      TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (foundation_type)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS tower_tank_prices (
  id             INT UNSIGNED  NOT NULL AUTO_INCREMENT,
  tank_type      VARCHAR(20)   NOT NULL,   -- 'plastic' (Jojo) or 'steel'
  capacity_key   VARCHAR(20)   NOT NULL,   -- normalized, e.g. '10000l', '50m3'
  capacity_label VARCHAR(50)   NOT NULL,   -- display label, e.g. '10,000L', '50m³'
  price          DECIMAL(12,2) NOT NULL,
  updated_at     TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uniq_type_capacity (tank_type, capacity_key)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- fabrication_price is item 1.00 on the quote PDF ("FABRICATION AND ASSEMBLING OF Xm STEEL
-- TOWER") — the foundation and tank costs are looked up separately (tables above) and summed
-- with this to get the complete package total, so editing one component never requires
-- recomputing the others by hand.
CREATE TABLE IF NOT EXISTS tower_packages (
  id                INT UNSIGNED  NOT NULL AUTO_INCREMENT,
  height_m          INT UNSIGNED  NOT NULL,
  tank_count        INT UNSIGNED  NOT NULL,
  tank_type         VARCHAR(20)   NOT NULL,
  capacity_key      VARCHAR(20)   NOT NULL,
  capacity_label    VARCHAR(50)   NOT NULL,
  foundation_type   VARCHAR(10)   NOT NULL,   -- 'pad' or 'raft'
  fabrication_price DECIMAL(12,2) NOT NULL,
  updated_at        TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uniq_config (height_m, tank_count, tank_type, capacity_key)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Seed data — the values already confirmed with the business (2026-07). INSERT IGNORE so
-- re-running this file (e.g. re-importing schema.sql) never clobbers admin edits made since.
INSERT IGNORE INTO tower_foundation_prices (foundation_type, price) VALUES
  ('pad', 222300.00),
  ('raft', 440507.50);

INSERT IGNORE INTO tower_tank_prices (tank_type, capacity_key, capacity_label, price) VALUES
  ('plastic', '10000l', '10,000L', 104310.00),
  ('steel', '24m3', '24m³', 728000.00),
  ('steel', '48m3', '48m³', 1105000.00),
  ('steel', '50m3', '50m³', 1170000.00),
  ('steel', '100m3', '100m³', 1950000.00);

INSERT IGNORE INTO tower_packages (height_m, tank_count, tank_type, capacity_key, capacity_label, foundation_type, fabrication_price) VALUES
  (6, 2, 'plastic', '10000l', '10,000L', 'pad', 431288.00),
  (6, 4, 'plastic', '10000l', '10,000L', 'pad', 620833.00),
  (9, 2, 'plastic', '10000l', '10,000L', 'pad', 567008.00),
  (9, 4, 'plastic', '10000l', '10,000L', 'raft', 793208.00),
  (12, 1, 'steel', '24m3', '24m³', 'raft', 702728.50),
  (12, 1, 'steel', '48m3', '48m³', 'raft', 1109888.00),
  (6, 1, 'steel', '50m3', '50m³', 'raft', 780000.00),
  (6, 1, 'steel', '100m3', '100m³', 'raft', 1365000.00),
  (9, 1, 'steel', '50m3', '50m³', 'raft', 975000.00),
  (9, 1, 'steel', '100m3', '100m³', 'raft', 1690000.00),
  (12, 1, 'steel', '50m3', '50m³', 'raft', 1131000.00),
  (12, 1, 'steel', '100m3', '100m³', 'raft', 2080000.00);

-- Drilling quotation pricing — admin-editable inputs for the drilling costing/quote engine
-- (src/services/drillingCalc.js). Automates what used to be a manual costing-sheet
-- calculation (fuel, casings, gravel, consumables -> a per-metre "costing rate" -> the
-- customer-facing quote) so rates that drift over time (fuel price, casing cost, etc.) are
-- an admin-editable setting, not a code change.

CREATE TABLE IF NOT EXISTS drilling_settings (
  setting_key   VARCHAR(100) NOT NULL,
  setting_value TEXT         DEFAULT NULL,
  updated_at    TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (setting_key)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Penetration-rate presets (minutes per rod / rod length -> a fuel-litres-per-metre factor
-- used to estimate compressor fuel consumption for a given depth).
CREATE TABLE IF NOT EXISTS drilling_penetration_rates (
  id              INT UNSIGNED  NOT NULL AUTO_INCREMENT,
  label           VARCHAR(100)  NOT NULL,
  minutes_per_rod DECIMAL(6,2)  NOT NULL,
  rod_length_m    DECIMAL(6,2)  NOT NULL DEFAULT 5,
  PRIMARY KEY (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Standard line items: drilling-site consumables (category='consumable', feeds the internal
-- costing total) and mobilization associated costs (category='mobilization', reused for both
-- the rig and the support truck in the quote UI — each is independently toggled/edited per
-- quote since which ones apply varies job to job). Defaults are prefilled per quote but always
-- overridable.
CREATE TABLE IF NOT EXISTS drilling_line_items (
  id           INT UNSIGNED  NOT NULL AUTO_INCREMENT,
  category     VARCHAR(20)   NOT NULL,
  name         VARCHAR(150)  NOT NULL,
  default_qty  DECIMAL(10,3) NOT NULL DEFAULT 1,
  default_rate DECIMAL(12,2) NOT NULL,
  sort_order   INT UNSIGNED  NOT NULL DEFAULT 0,
  PRIMARY KEY (id),
  INDEX idx_category (category)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

INSERT IGNORE INTO drilling_settings (setting_key, setting_value) VALUES
  ('fuel_rate_per_litre', '234'),
  ('flushing_fuel_litres_default', '120'),
  ('rig_fuel_litres_default', '200'),
  ('test_pumping_fuel_litres_default', '200'),
  ('casing_rate_per_metre', '3000'),
  ('drilling_rate_deduction', '3000'),
  ('surface_casing_rate', '12000'),
  ('casing_plain_split_pct', '70'),
  ('casing_screened_split_pct', '30'),
  ('casing_pipe_length_m', '6'),
  ('plain_casing_unit_rate', '11832'),
  ('screened_casing_unit_rate', '13688'),
  ('gravel_tonnes_per_metre', '0.021'),
  ('gravel_bag_size_kg', '50'),
  ('gravel_rate_per_bag', '560'),
  ('vat_rate_pct', '16'),
  ('payment_deposit_pct', '70'),
  ('payment_before_test_pumping_flat', '60000'),
  ('fuel_consumption_tarmac_km_per_l', '2.8'),
  ('fuel_consumption_rough_km_per_l', '1.5');

INSERT IGNORE INTO drilling_penetration_rates (label, minutes_per_rod, rod_length_m) VALUES
  ('50 min/rod', 50, 5),
  ('40 min/rod', 40, 5);

INSERT IGNORE INTO drilling_line_items (category, name, default_qty, default_rate, sort_order) VALUES
  ('consumable', 'FOOD SUPPLIES-DRILLING TEAM', 1, 7255.00, 10),
  ('consumable', 'FOOD SUPPLIES-TEST PUMPING TEAM', 1, 3150.00, 20),
  ('consumable', 'DRILLING FOAM', 5, 1900.00, 30),
  ('consumable', 'POLYMER', 0.15, 30879.00, 40),
  ('consumable', 'BENTONITE', 0, 4060.00, 50),
  ('consumable', 'COMPRESSOR OIL', 0.5, 12000.00, 60),
  ('consumable', 'HAMMER OIL', 0.5, 9500.00, 70),
  ('consumable', 'GREASE', 0.25, 20750.00, 80),
  ('consumable', 'WELDING RODS', 1, 1500.00, 90),
  ('consumable', 'CUTTING DISKS', 2, 200.00, 100),
  ('consumable', 'GRINDING DISKS', 1, 200.00, 110),
  ('consumable', 'COOLANT (5L)', 1, 2950.00, 120),
  ('consumable', 'HYDRAULIC OIL', 0.5, 7310.00, 130),
  ('consumable', 'CABLE TIES AND TAPES', 1, 1800.00, 140),
  ('consumable', 'TRAFFIC (RIG & SUPPORT)', 1, 1000.00, 150),
  ('consumable', 'TRAFFIC (TPU)', 1, 1000.00, 160),
  ('consumable', 'Water Analysis', 1, 10000.00, 170),
  ('consumable', 'Borehole Cap', 1, 500.00, 180),
  ('consumable', 'DRILLING WATER LITRES', 1, 5000.00, 190),
  ('mobilization', 'TRAFFIC', 2, 1500.00, 10),
  ('mobilization', 'ACCOMMODATION AND PARKING', 2, 8400.00, 20),
  ('mobilization', 'FOOD SUPPLY', 0, 7255.00, 30),
  ('mobilization', 'WEAR AND TEAR', 1, 15000.00, 40),
  ('mobilization', 'SECURITY', 0, 10000.00, 50);

-- Solar system quotation pricing — admin-editable bill-of-quantities per kVA tier
-- (src/services/solarQuote.js). Unlike drilling, panel count and cable runs are engineered per
-- site rather than derived from a formula, so each tier is an editable template (like Tower
-- Pricing's packages) that the admin starts from and adjusts per job, not a calculator. Seeded
-- from 6 real reference quotations (3/5/12/20/30/50 kVA). `category` drives the VAT split shown
-- on the quote as "VAT on Non-Solar": 'exempt' = solar power-generation equipment (panels,
-- battery, inverter, battery disconnect unit) which is VAT-free under Kenya's solar equipment
-- exemption; 'taxable' = everything else (cables, breakers, mounting, labour, transport,
-- commissioning), taxed at solar_settings.vat_rate_pct.

CREATE TABLE IF NOT EXISTS solar_kva_tiers (
  tier_key    VARCHAR(30)  NOT NULL,
  label       VARCHAR(100) NOT NULL,
  sort_order  INT UNSIGNED NOT NULL DEFAULT 0,
  PRIMARY KEY (tier_key)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS solar_line_items (
  id            INT UNSIGNED  NOT NULL AUTO_INCREMENT,
  tier_key      VARCHAR(30)   NOT NULL,
  category      ENUM('exempt','taxable') NOT NULL,
  name          VARCHAR(150)  NOT NULL,
  default_qty   DECIMAL(10,3) NOT NULL DEFAULT 1,
  default_rate  DECIMAL(12,2) NOT NULL,
  sort_order    INT UNSIGNED  NOT NULL DEFAULT 0,
  PRIMARY KEY (id),
  INDEX idx_tier (tier_key)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS solar_settings (
  setting_key   VARCHAR(100) NOT NULL,
  setting_value TEXT         DEFAULT NULL,
  PRIMARY KEY (setting_key)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

INSERT IGNORE INTO solar_settings (setting_key, setting_value) VALUES
  ('vat_rate_pct', '16');

INSERT IGNORE INTO solar_kva_tiers (tier_key, label, sort_order) VALUES
  ('3kva',  '3 kVA',  10),
  ('5kva',  '5 kVA',  20),
  ('12kva', '12 kVA', 30),
  ('20kva', '20 kVA', 40),
  ('30kva', '30 kVA', 50),
  ('50kva', '50 kVA', 60);

INSERT IGNORE INTO solar_line_items (tier_key, category, name, default_qty, default_rate, sort_order) VALUES
  -- 3 kVA
  ('3kva', 'exempt',  'Solar panels 600W', 5, 13640.00, 10),
  ('3kva', 'exempt',  'Lithium Valley Battery 5.1kwh 48VDC', 1, 106200.00, 20),
  ('3kva', 'exempt',  '3kVA TBB Rio Sun II Hybrid Inverter', 1, 69620.00, 30),
  ('3kva', 'taxable', 'Battery Cable 35mm', 2, 1121.00, 40),
  ('3kva', 'taxable', 'Battery Fuse', 1, 5530.00, 50),
  ('3kva', 'taxable', 'PV cable 4mm red', 40, 153.40, 60),
  ('3kva', 'taxable', 'PV cable 4mm black', 40, 153.40, 70),
  ('3kva', 'taxable', '160A Fuse complete with housing', 1, 5900.00, 80),
  ('3kva', 'taxable', 'Double pole DC 63A', 1, 4248.00, 90),
  ('3kva', 'taxable', 'AC Breakers 4 pole', 1, 5310.00, 100),
  ('3kva', 'taxable', 'SPD 500VDC', 1, 3304.00, 110),
  ('3kva', 'taxable', 'Double Pole', 1, 3540.00, 120),
  ('3kva', 'taxable', 'AVS 30', 1, 8248.00, 130),
  ('3kva', 'taxable', 'Combiner box suntree 6-way', 1, 4956.00, 140),
  ('3kva', 'taxable', 'Change over', 1, 5310.00, 150),
  ('3kva', 'taxable', 'Aluminium rail sets', 1, 14160.00, 160),
  ('3kva', 'taxable', 'Trunking 2 x 2', 1, 1770.00, 170),
  ('3kva', 'taxable', 'Installation sundries', 1, 5900.00, 180),
  ('3kva', 'taxable', '4mm Flex Cable 4-Core', 5, 706.80, 190),
  ('3kva', 'taxable', 'Transport and Logistics', 1, 28910.00, 200),
  ('3kva', 'taxable', 'Labour', 1, 35400.00, 210),
  ('3kva', 'taxable', 'Testing and Commissioning', 1, 18290.00, 220),

  -- 5 kVA
  ('5kva', 'exempt',  '600w Crystalline Solar Panels', 8, 13750.00, 10),
  ('5kva', 'exempt',  '10.2kwh Lithium Battery-Wall mount', 1, 198240.00, 20),
  ('5kva', 'exempt',  '5kVA -48V Hybrid Inverter', 1, 105020.00, 30),
  ('5kva', 'taxable', '35mm Battery Cable', 6, 1121.00, 40),
  ('5kva', 'taxable', '6mm DC solar Cable- Red', 40, 200.60, 50),
  ('5kva', 'taxable', '6mm DC solar Cable- Black', 40, 200.60, 60),
  ('5kva', 'taxable', 'AC Breakers', 2, 2360.00, 70),
  ('5kva', 'taxable', 'Double pole DC 63A', 1, 4248.00, 80),
  ('5kva', 'taxable', '160A Fuse complete with housing', 1, 5900.00, 90),
  ('5kva', 'taxable', 'SPD DC', 2, 4380.00, 100),
  ('5kva', 'taxable', 'Earthing including lightning arrestor and earth rods', 1, 10700.00, 110),
  ('5kva', 'taxable', '12-Way CCU', 1, 4791.00, 120),
  ('5kva', 'taxable', 'Change Over Switch 40A', 1, 5310.00, 130),
  ('5kva', 'taxable', 'AVS 30', 1, 8142.00, 140),
  ('5kva', 'taxable', 'Structure Set', 1, 29500.00, 150),
  ('5kva', 'taxable', '32mm Conduits, bends and couplers', 1, 7392.00, 160),
  ('5kva', 'taxable', 'Trunking 4 x 2', 2, 1770.00, 170),
  ('5kva', 'taxable', 'Installation sundries', 1, 8850.00, 180),
  ('5kva', 'taxable', '4mm Auto Cable', 5, 706.80, 190),
  ('5kva', 'taxable', 'Labour', 1, 44250.00, 200),
  ('5kva', 'taxable', 'Transport and Logistics', 1, 24375.00, 210),
  ('5kva', 'taxable', 'Testing and Commissioning', 1, 17050.00, 220),

  -- 12 kVA
  ('12kva', 'exempt',  'Solar panels 600W', 10, 13640.00, 10),
  ('12kva', 'exempt',  'Lithium Valley Battery 5.12kwh 48VDC', 1, 198240.00, 20),
  ('12kva', 'exempt',  '12kVA TBB Rio Sun II Hybrid Inverter', 1, 254150.00, 30),
  ('12kva', 'taxable', 'Battery Cable 35mm', 2, 1121.00, 40),
  ('12kva', 'taxable', 'Battery Fuse', 1, 5310.00, 50),
  ('12kva', 'taxable', 'PV cable 4mm red', 40, 153.40, 60),
  ('12kva', 'taxable', 'PV cable 4mm black', 40, 153.40, 70),
  ('12kva', 'taxable', 'Double pole DC 63A', 3, 4248.00, 80),
  ('12kva', 'taxable', 'AC Breakers 4 pole', 3, 5310.00, 90),
  ('12kva', 'taxable', 'SPD 500VDC', 3, 3304.00, 100),
  ('12kva', 'taxable', 'Combiner box suntree 6-way', 2, 4956.00, 110),
  ('12kva', 'taxable', 'Earthing including lightning arrestors and earth rods', 1, 17700.00, 120),
  ('12kva', 'taxable', 'Change over', 1, 5310.00, 130),
  ('12kva', 'taxable', 'Aluminium rail sets', 1, 33984.00, 140),
  ('12kva', 'taxable', 'Trunking 2 x 2', 1, 1770.00, 150),
  ('12kva', 'taxable', 'Installation sundries', 1, 8850.00, 160),
  ('12kva', 'taxable', '4mm Flex Cable 4-Core', 5, 706.80, 170),
  ('12kva', 'taxable', 'Labour', 1, 41300.00, 180),
  ('12kva', 'taxable', 'Testing and Commissioning', 1, 24190.00, 190),

  -- 20 kVA
  ('20kva', 'exempt',  '700w Crystalline Solar Panels', 30, 15840.00, 10),
  ('20kva', 'exempt',  '10.2kwh Lithium Battery-Wall mount', 4, 198240.00, 20),
  ('20kva', 'exempt',  '20kVA -48V Hybrid Inverter LV', 1, 434240.00, 30),
  ('20kva', 'taxable', '50mm Battery Cable', 10, 1357.00, 40),
  ('20kva', 'taxable', '10mm DC solar Cable- Red', 100, 295.00, 50),
  ('20kva', 'taxable', '10mm DC solar Cable- Black', 100, 295.00, 60),
  ('20kva', 'taxable', 'AC Breakers', 3, 2360.00, 70),
  ('20kva', 'taxable', '400A Fuse complete with housing', 1, 6490.00, 80),
  ('20kva', 'taxable', 'Double Pole', 3, 3540.00, 90),
  ('20kva', 'taxable', 'SPD DC', 3, 6159.67, 100),
  ('20kva', 'taxable', '12-Way Enclosure', 2, 4791.00, 110),
  ('20kva', 'taxable', 'Change Over Switch', 1, 6490.00, 120),
  ('20kva', 'taxable', 'AVS 30 3PH', 1, 31435.00, 130),
  ('20kva', 'taxable', 'Structure Set', 1, 92040.00, 140),
  ('20kva', 'taxable', 'Earthing including lightning arrestors and earth rods', 1, 17700.00, 150),
  ('20kva', 'taxable', 'Trunking 4 x 2', 2, 1770.00, 160),
  ('20kva', 'taxable', 'Installation sundries', 1, 10620.00, 170),
  ('20kva', 'taxable', '6mm Auto Cable', 15, 885.00, 180),
  ('20kva', 'taxable', 'Labour', 1, 64900.00, 190),
  ('20kva', 'taxable', 'Transport and Logistics', 1, 40625.00, 200),
  ('20kva', 'taxable', 'Testing and Commissioning', 1, 27140.00, 210),

  -- 30 kVA
  ('30kva', 'exempt',  'Solar panels 715W', 30, 15730.00, 10),
  ('30kva', 'exempt',  'Lithium Battery 10.2kwh 48VDC High Voltage', 7, 221400.00, 20),
  ('30kva', 'exempt',  '30kVA Deye Hybrid Inverter High Voltage', 1, 538200.00, 30),
  ('30kva', 'exempt',  'Battery Disconnect Unit', 1, 138000.00, 40),
  ('30kva', 'taxable', 'Battery Cable 50mm', 12, 1260.00, 50),
  ('30kva', 'taxable', '400A Battery Fuse complete with housings', 1, 19800.00, 60),
  ('30kva', 'taxable', 'PV cable 10mm red', 100, 276.00, 70),
  ('30kva', 'taxable', 'PV cable 10mm black', 100, 276.00, 80),
  ('30kva', 'taxable', 'Double pole DC 63A', 3, 5400.00, 90),
  ('30kva', 'taxable', 'AC Breakers', 3, 2400.00, 100),
  ('30kva', 'taxable', 'SPD 500VDC', 3, 6000.00, 110),
  ('30kva', 'taxable', 'MCCB 63A', 1, 25200.00, 120),
  ('30kva', 'taxable', 'AVS 30 3PH-Sollatek', 2, 31968.00, 130),
  ('30kva', 'taxable', 'DC Busbar', 1, 27960.00, 140),
  ('30kva', 'taxable', 'Combiner box with Busbar', 1, 39840.00, 150),
  ('30kva', 'taxable', 'Earthing and Lightning arrestor', 1, 28080.00, 160),
  ('30kva', 'taxable', 'Change over Switch', 1, 6600.00, 170),
  ('30kva', 'taxable', 'Aluminium rail sets and clamps', 1, 93600.00, 180),
  ('30kva', 'taxable', 'Trunking 2 x 2', 2, 1800.00, 190),
  ('30kva', 'taxable', 'Installation sundries', 1, 18000.00, 200),
  ('30kva', 'taxable', '10mm Flex Cable 4-Core', 10, 1740.00, 210),
  ('30kva', 'taxable', 'Labour, Testing and Commissioning', 1, 199584.00, 220),
  ('30kva', 'taxable', 'Transport and Logistics', 1, 28750.00, 230),

  -- 50 kVA
  ('50kva', 'exempt',  'Solar panels 715W', 36, 15840.00, 10),
  ('50kva', 'exempt',  'Lithium Battery 10.2kwh 48VDC High Voltage', 4, 221400.00, 20),
  ('50kva', 'exempt',  '50kVA Deye Hybrid Inverter High Voltage', 1, 720000.00, 30),
  ('50kva', 'exempt',  'Battery Disconnect Unit', 1, 135700.00, 40),
  ('50kva', 'taxable', 'Battery Cable 50mm', 10, 1239.00, 50),
  ('50kva', 'taxable', 'Battery Fuse', 2, 5530.00, 60),
  ('50kva', 'taxable', 'PV cable 10mm red', 100, 271.40, 70),
  ('50kva', 'taxable', 'PV cable 10mm black', 100, 271.40, 80),
  ('50kva', 'taxable', 'Double pole DC 63A', 3, 5310.00, 90),
  ('50kva', 'taxable', 'AC Breakers 4 pole', 3, 2360.00, 100),
  ('50kva', 'taxable', 'SPD 500VDC', 3, 5900.00, 110),
  ('50kva', 'taxable', 'MCCB 63A', 2, 24780.00, 120),
  ('50kva', 'taxable', 'AVS 30 3PH-Sollatek', 1, 31435.00, 130),
  ('50kva', 'taxable', 'DC Busbar', 1, 27494.00, 140),
  ('50kva', 'taxable', 'Combiner Box with Busbar', 1, 39266.00, 150),
  ('50kva', 'taxable', 'Earthing and Lightning arrestor', 1, 27612.00, 160),
  ('50kva', 'taxable', 'Change over Switch', 1, 6490.00, 170),
  ('50kva', 'taxable', 'Aluminium rail sets', 1, 110448.00, 180),
  ('50kva', 'taxable', 'Trunking 2 x 2', 2, 1770.00, 190),
  ('50kva', 'taxable', 'Installation sundries', 1, 41300.00, 200),
  ('50kva', 'taxable', '16mm Flex Cable 4-Core', 10, 2124.00, 210),
  ('50kva', 'taxable', 'Labour', 1, 199584.00, 220),
  ('50kva', 'taxable', 'Testing and Commissioning', 1, 36300.00, 230);
