CREATE TABLE device_observations (
  cloudflare_device_id TEXT PRIMARY KEY,
  observation_id TEXT NOT NULL,
  observed_at INTEGER NOT NULL
);

CREATE INDEX idx_device_observations_time
  ON device_observations(observed_at);
