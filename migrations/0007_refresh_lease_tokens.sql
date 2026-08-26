ALTER TABLE refresh_leases ADD COLUMN lease_token TEXT;

CREATE INDEX idx_refresh_leases_token ON refresh_leases(lease_token);
