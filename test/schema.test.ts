import { describe, expect, it } from "vitest";
import { ensureSchema } from "../src/schema";

function capturingDb(): { db: D1Database; statements: string[]; bound: unknown[][] } {
  const statements: string[] = [];
  const bound: unknown[][] = [];
  const statement = {
    bind: (...values: unknown[]) => {
      bound.push(values);
      return statement;
    },
    all: async () => ({ results: [] }),
    first: async () => null,
    run: async () => ({}),
  };
  const db = {
    prepare: (sql: string) => {
      statements.push(sql);
      return statement;
    },
    batch: async (stmts: unknown[]) => stmts.map(() => ({})),
  };
  return { db: db as unknown as D1Database, statements, bound };
}

describe("schema bootstrap", () => {
  it("creates every table and index idempotently", async () => {
    const { db, statements } = capturingDb();
    await ensureSchema(db);

    for (const table of [
      "d1_migrations",
      "device_mappings",
      "endpoint_snapshots",
      "integration_status",
      "refresh_leases",
      "device_observations",
      "sync_leases",
      "serial_removals",
      "app_settings",
    ]) {
      expect(
        statements.some((sql) =>
          sql.replace(/"/g, "").includes(`CREATE TABLE IF NOT EXISTS ${table}`),
        ),
      ).toBe(true);
    }
    for (const index of [
      "idx_device_mappings_endpoint",
      "idx_endpoint_snapshots_refresh",
      "idx_refresh_leases_expiry",
      "idx_refresh_leases_token",
      "idx_device_observations_time",
      "idx_sync_leases_expiry",
      "idx_serial_removals_observed",
    ]) {
      expect(
        statements.some((sql) => sql.includes(`CREATE INDEX IF NOT EXISTS ${index}`)),
      ).toBe(true);
    }
  });

  it("registers all migrations and seeds integration rows", async () => {
    const { db, statements, bound } = capturingDb();
    await ensureSchema(db);

    expect(
      statements.some((sql) => sql.startsWith("INSERT OR IGNORE INTO d1_migrations")),
    ).toBe(true);
    const migrationBind = bound.find(
      (values) => values.length === 8 && values.every((v) => typeof v === "string"),
    );
    expect(migrationBind).toEqual([
      "0001_initial",
      "0002_gateway_virtual_ip",
      "0003_device_observations",
      "0004_serial_denylist_status",
      "0005_sync_leases",
      "0006_serial_removals",
      "0007_refresh_lease_tokens",
      "0008_app_settings",
    ]);
    expect(
      statements.filter((sql) => sql.includes("INSERT OR IGNORE INTO integration_status"))
        .length,
    ).toBe(2);
  });
});
