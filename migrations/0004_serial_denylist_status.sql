INSERT OR IGNORE INTO integration_status(name, status, updated_at)
VALUES ('cloudflare_serial_list', 'unknown', unixepoch() * 1000);
