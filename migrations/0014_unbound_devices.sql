CREATE TABLE unbound_devices (
  cloudflare_device_id TEXT PRIMARY KEY,
  hostname TEXT NOT NULL,
  serial_number TEXT,
  mac_address TEXT,
  last_attempt_at INTEGER NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 1,
  last_reason TEXT NOT NULL
);

CREATE INDEX idx_unbound_devices_attempt
  ON unbound_devices(last_attempt_at);
