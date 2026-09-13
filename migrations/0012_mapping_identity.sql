ALTER TABLE device_mappings ADD COLUMN verified_macs TEXT;
ALTER TABLE device_mappings ADD COLUMN drifted_at INTEGER;

UPDATE device_mappings
   SET verified_macs = json_array(verified_mac)
 WHERE verified_macs IS NULL
   AND TRIM(COALESCE(verified_mac, '')) != '';
