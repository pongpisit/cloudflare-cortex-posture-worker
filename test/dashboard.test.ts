import { describe, expect, it } from "vitest";
import {
  getDashboardIntegrations,
  getDeviceCounts,
  listDeviceCompliance,
} from "../src/repository";

function fakeDb<T>(rows: T[]): D1Database {
  const statement = {
    bind: () => statement,
    all: async () => ({ results: rows }),
    first: async () => rows[0] ?? null,
  };
  return { prepare: () => statement } as unknown as D1Database;
}

describe("dashboard repository", () => {
  it("maps device counts", async () => {
    const db = fakeDb([{ total: 12, verified: 10, invalid: 2 }]);
    await expect(getDeviceCounts(db)).resolves.toEqual({
      total: 12,
      verified: 10,
      invalid: 2,
    });
  });

  it("returns zero counts when no mappings exist", async () => {
    const db = fakeDb([]);
    await expect(getDeviceCounts(db)).resolves.toEqual({
      total: 0,
      verified: 0,
      invalid: 0,
    });
  });

  it("maps integration status rows", async () => {
    const db = fakeDb([
      {
        name: "cortex",
        status: "healthy",
        message: null,
        last_success_at: 1000,
        last_error_at: null,
        updated_at: 1000,
      },
    ]);
    await expect(getDashboardIntegrations(db)).resolves.toEqual([
      {
        name: "cortex",
        status: "healthy",
        message: null,
        lastSuccessAt: 1000,
        lastErrorAt: null,
        updatedAt: 1000,
      },
    ]);
  });

  it("marks stale content noncompliant and fresh or missing content compliant", async () => {
    const age = 7 * 86_400_000;
    const refreshed = 1_700_000_000_000;
    const db = fakeDb([
      {
        cloudflare_device_id: "device-a",
        serial_number: "S1",
        hostname: "laptop-a",
        verified_mac: "aabbccddeeff",
        mapping_status: "verified",
        score: 0,
        reason: "content_older_than_allowed",
        last_content_update_time: refreshed - age - 1,
        cortex_refreshed_at: refreshed,
      },
      {
        cloudflare_device_id: "device-b",
        serial_number: "S2",
        hostname: "laptop-b",
        verified_mac: null,
        mapping_status: "verified",
        score: 100,
        reason: "content_fresh",
        last_content_update_time: refreshed - 1000,
        cortex_refreshed_at: refreshed,
      },
      {
        cloudflare_device_id: "device-c",
        serial_number: null,
        hostname: "laptop-c",
        verified_mac: null,
        mapping_status: "verified",
        score: 0,
        reason: "last_content_update_missing",
        last_content_update_time: 0,
        cortex_refreshed_at: refreshed,
      },
      {
        cloudflare_device_id: "device-d",
        serial_number: "S4",
        hostname: "laptop-d",
        verified_mac: null,
        mapping_status: "invalid",
        score: 0,
        reason: "endpoint_not_found_or_ambiguous",
        last_content_update_time: refreshed - age - 1,
        cortex_refreshed_at: refreshed,
      },
    ]);

    const devices = await listDeviceCompliance(db, age, "all", 50);

    expect(devices[0]).toMatchObject({
      cloudflareDeviceId: "device-a",
      serialNumber: "S1",
      hostname: "laptop-a",
      noncompliant: true,
    });
    expect(devices[1]).toMatchObject({
      cloudflareDeviceId: "device-b",
      noncompliant: false,
    });
    expect(devices[2]).toMatchObject({
      cloudflareDeviceId: "device-c",
      noncompliant: false,
    });
    expect(devices[3]).toMatchObject({
      cloudflareDeviceId: "device-d",
      mappingStatus: "invalid",
      noncompliant: false,
    });
  });
});
