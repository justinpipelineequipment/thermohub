-- ThermoHub cloud database (Cloudflare D1 / SQLite).
-- Apply with: npx wrangler d1 execute thermohub --remote --file=schema.sql

CREATE TABLE IF NOT EXISTS businesses (
  id              TEXT PRIMARY KEY,
  name            TEXT NOT NULL,
  tenant_id       TEXT UNIQUE,          -- Microsoft Entra tenant ID (tid claim)
  tenant_domain   TEXT,
  hub_token_hash  TEXT,                 -- SHA-256 of the hub's secret token
  hub_last_seen   INTEGER,
  hub_version     TEXT,
  config_version  INTEGER NOT NULL DEFAULT 0,  -- bumped on any change the hub must pick up
  created_at      INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS buildings (
  id           TEXT PRIMARY KEY,
  business_id  TEXT NOT NULL REFERENCES businesses(id),
  name         TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_buildings_business ON buildings(business_id);

-- data: JSON { occupied, unoccupied, days, motionRule, recovery, localAdjust }
CREATE TABLE IF NOT EXISTS schedules (
  id           TEXT PRIMARY KEY,
  business_id  TEXT NOT NULL REFERENCES businesses(id),
  name         TEXT NOT NULL,
  data         TEXT NOT NULL,
  updated_at   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_schedules_business ON schedules(business_id);

-- Desired settings are set from the dashboard; state is reported by the hub.
CREATE TABLE IF NOT EXISTS thermostats (
  id           TEXT PRIMARY KEY,
  business_id  TEXT NOT NULL REFERENCES businesses(id),
  building_id  TEXT REFERENCES buildings(id),   -- NULL until an admin places it
  schedule_id  TEXT REFERENCES schedules(id),
  name         TEXT NOT NULL,
  entity       TEXT NOT NULL,                   -- Home Assistant entity id on the hub
  model        TEXT,
  mode         TEXT NOT NULL DEFAULT 'auto',
  hold         TEXT,                            -- JSON manual hold, or NULL
  hold_seq     INTEGER NOT NULL DEFAULT 0,      -- bumped on hold/resume so the hub applies it once
  state        TEXT,                            -- JSON last report from the hub
  reported_at  INTEGER,
  UNIQUE (business_id, entity)
);
CREATE INDEX IF NOT EXISTS idx_thermostats_business ON thermostats(business_id);

CREATE TABLE IF NOT EXISTS users (
  id            TEXT PRIMARY KEY,
  business_id   TEXT NOT NULL REFERENCES businesses(id),
  email         TEXT NOT NULL,                  -- lowercase work email (Microsoft 365 sign-in name)
  name          TEXT NOT NULL,
  role          TEXT NOT NULL,                  -- business_admin | building_manager | viewer
  building_ids  TEXT NOT NULL DEFAULT '[]',     -- JSON array; empty = all buildings
  oid           TEXT,                           -- Entra object id, recorded at first sign-in
  UNIQUE (business_id, email)
);

CREATE TABLE IF NOT EXISTS audit (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  ts             INTEGER NOT NULL,
  business_id    TEXT NOT NULL,
  user_name      TEXT NOT NULL,
  text           TEXT NOT NULL,
  thermostat_id  TEXT
);
CREATE INDEX IF NOT EXISTS idx_audit_business_ts ON audit(business_id, ts DESC);

-- Motion periods, recorded from hub reports (occupied false -> true -> false). Kept one year.
CREATE TABLE IF NOT EXISTS motion (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  business_id    TEXT NOT NULL,
  thermostat_id  TEXT NOT NULL,
  start_ts       INTEGER NOT NULL,
  end_ts         INTEGER                        -- NULL while motion continues
);
CREATE INDEX IF NOT EXISTS idx_motion_business_start ON motion(business_id, start_ts);
CREATE INDEX IF NOT EXISTS idx_motion_thermostat_open ON motion(thermostat_id, end_ts);
