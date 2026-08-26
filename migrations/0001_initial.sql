CREATE TABLE device_mappings (
  cloudflare_device_id TEXT PRIMARY KEY,
  serial_number TEXT,
  cortex_endpoint_id TEXT NOT NULL,
  hostname TEXT NOT NULL,
  verified_mac TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'verified',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  last_verified_at INTEGER NOT NULL
);

CREATE INDEX idx_device_mappings_endpoint
  ON device_mappings(cortex_endpoint_id);

CREATE TABLE endpoint_snapshots (
  cortex_endpoint_id TEXT PRIMARY KEY,
  endpoint_name TEXT NOT NULL,
  operational_status TEXT NOT NULL,
  last_content_update_time INTEGER NOT NULL,
  last_seen INTEGER NOT NULL,
  score INTEGER NOT NULL CHECK(score BETWEEN 0 AND 100),
  reason TEXT NOT NULL,
  cortex_refreshed_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX idx_endpoint_snapshots_refresh
  ON endpoint_snapshots(cortex_refreshed_at);

CREATE TABLE integration_status (
  name TEXT PRIMARY KEY,
  status TEXT NOT NULL,
  message TEXT,
  last_success_at INTEGER,
  last_error_at INTEGER,
  updated_at INTEGER NOT NULL
);

INSERT INTO integration_status(name, status, updated_at)
VALUES ('cortex', 'unknown', unixepoch() * 1000);

CREATE TABLE refresh_leases (
  cortex_endpoint_id TEXT PRIMARY KEY,
  leased_until INTEGER NOT NULL
);

CREATE INDEX idx_refresh_leases_expiry ON refresh_leases(leased_until);
