CREATE TABLE serial_removals (
  serial_number TEXT PRIMARY KEY,
  observed_at INTEGER NOT NULL
);

CREATE INDEX idx_serial_removals_observed ON serial_removals(observed_at);
