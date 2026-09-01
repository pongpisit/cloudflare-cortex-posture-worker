const MIGRATION_NAMES = [
  "0001_initial",
  "0002_gateway_virtual_ip",
  "0003_device_observations",
  "0004_serial_denylist_status",
  "0005_sync_leases",
  "0006_serial_removals",
  "0007_refresh_lease_tokens",
  "0008_app_settings",
] as const;

// Idempotent equivalent of migrations 0001-0008, executed as one D1 batch
// (transaction). The Worker self-provisions its schema so a deployment bound
// to a fresh database recovers on the first Cron run even when
// `wrangler d1 migrations apply` has not run. The d1_migrations rows keep
// Wrangler's migration tracking consistent.
export async function ensureSchema(db: D1Database): Promise<void> {
  await db.batch([
    db.prepare(`CREATE TABLE IF NOT EXISTS "d1_migrations"(
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      name       TEXT UNIQUE,
      applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL
    )`),
    db.prepare(`CREATE TABLE IF NOT EXISTS device_mappings (
      cloudflare_device_id TEXT PRIMARY KEY,
      serial_number TEXT,
      cortex_endpoint_id TEXT NOT NULL,
      hostname TEXT NOT NULL,
      verified_mac TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'verified',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      last_verified_at INTEGER NOT NULL,
      virtual_ipv4 TEXT
    )`),
    db.prepare(`CREATE TABLE IF NOT EXISTS endpoint_snapshots (
      cortex_endpoint_id TEXT PRIMARY KEY,
      endpoint_name TEXT NOT NULL,
      operational_status TEXT NOT NULL,
      last_content_update_time INTEGER NOT NULL,
      last_seen INTEGER NOT NULL,
      score INTEGER NOT NULL CHECK(score BETWEEN 0 AND 100),
      reason TEXT NOT NULL,
      cortex_refreshed_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )`),
    db.prepare(`CREATE TABLE IF NOT EXISTS integration_status (
      name TEXT PRIMARY KEY,
      status TEXT NOT NULL,
      message TEXT,
      last_success_at INTEGER,
      last_error_at INTEGER,
      updated_at INTEGER NOT NULL
    )`),
    db.prepare(`CREATE TABLE IF NOT EXISTS refresh_leases (
      cortex_endpoint_id TEXT PRIMARY KEY,
      leased_until INTEGER NOT NULL,
      lease_token TEXT
    )`),
    db.prepare(`CREATE TABLE IF NOT EXISTS device_observations (
      cloudflare_device_id TEXT PRIMARY KEY,
      observation_id TEXT NOT NULL,
      observed_at INTEGER NOT NULL
    )`),
    db.prepare(`CREATE TABLE IF NOT EXISTS sync_leases (
      name TEXT PRIMARY KEY,
      lease_token TEXT NOT NULL,
      leased_until INTEGER NOT NULL
    )`),
    db.prepare(`CREATE TABLE IF NOT EXISTS serial_removals (
      serial_number TEXT PRIMARY KEY,
      observed_at INTEGER NOT NULL
    )`),
    db.prepare(`CREATE TABLE IF NOT EXISTS app_settings (
      name TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    )`),
    db.prepare(`CREATE INDEX IF NOT EXISTS idx_device_mappings_endpoint
      ON device_mappings(cortex_endpoint_id)`),
    db.prepare(`CREATE INDEX IF NOT EXISTS idx_device_mappings_virtual_ipv4
      ON device_mappings(virtual_ipv4)
      WHERE status = 'verified' AND virtual_ipv4 IS NOT NULL`),
    db.prepare(`CREATE INDEX IF NOT EXISTS idx_endpoint_snapshots_refresh
      ON endpoint_snapshots(cortex_refreshed_at)`),
    db.prepare(`CREATE INDEX IF NOT EXISTS idx_refresh_leases_expiry
      ON refresh_leases(leased_until)`),
    db.prepare(`CREATE INDEX IF NOT EXISTS idx_refresh_leases_token
      ON refresh_leases(lease_token)`),
    db.prepare(`CREATE INDEX IF NOT EXISTS idx_device_observations_time
      ON device_observations(observed_at)`),
    db.prepare(`CREATE INDEX IF NOT EXISTS idx_sync_leases_expiry
      ON sync_leases(leased_until)`),
    db.prepare(`CREATE INDEX IF NOT EXISTS idx_serial_removals_observed
      ON serial_removals(observed_at)`),
    db
      .prepare(
        `INSERT OR IGNORE INTO d1_migrations(name) VALUES ${MIGRATION_NAMES.map(
          () => "(?)",
        ).join(",")}`,
      )
      .bind(...MIGRATION_NAMES),
    db
      .prepare(
        `INSERT OR IGNORE INTO integration_status(name, status, updated_at)
         VALUES ('cortex', 'unknown', ?)`,
      )
      .bind(Date.now()),
    db
      .prepare(
        `INSERT OR IGNORE INTO integration_status(name, status, updated_at)
         VALUES ('cloudflare_serial_list', 'unknown', ?)`,
      )
      .bind(Date.now()),
  ]);
}
