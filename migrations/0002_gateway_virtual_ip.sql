ALTER TABLE device_mappings ADD COLUMN virtual_ipv4 TEXT;

CREATE INDEX idx_device_mappings_virtual_ipv4
  ON device_mappings(virtual_ipv4)
  WHERE status = 'verified' AND virtual_ipv4 IS NOT NULL;
