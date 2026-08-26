CREATE TABLE sync_leases (
  name TEXT PRIMARY KEY,
  lease_token TEXT NOT NULL,
  leased_until INTEGER NOT NULL
);

CREATE INDEX idx_sync_leases_expiry ON sync_leases(leased_until);
