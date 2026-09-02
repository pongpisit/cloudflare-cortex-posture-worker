import { describe, expect, it } from "vitest";
import {
  evaluateEndpoint,
  findCortexEndpoint,
  normalizeHostname,
  normalizeMac,
  normalizeMacCollection,
  normalizeTimestamp,
} from "../src/posture";
import type { CloudflareDevice, CortexEndpoint } from "../src/types";

const now = Date.UTC(2026, 7, 26, 0, 0, 0);

function endpoint(overrides: Partial<CortexEndpoint> = {}): CortexEndpoint {
  return {
    endpoint_id: "cortex-1",
    endpoint_name: "LAPTOP-001",
    operational_status: "protected",
    last_content_update_time: now - 6 * 86_400_000,
    last_seen: now - 10 * 60_000,
    mac_address: ["00:11:22:33:44:55"],
    ...overrides,
  };
}

const device: CloudflareDevice = {
  device_id: "cf-1",
  hostname: "laptop-001",
  mac_address: "00-11-22-33-44-55",
};

describe("device normalization", () => {
  it("normalizes hostnames and MAC formats", () => {
    expect(normalizeHostname(" Laptop-001. ")).toBe("laptop-001");
    expect([...normalizeMacCollection("0011.2233.4455")]).toEqual([
      "001122334455",
    ]);
  });

  it("normalizes epoch seconds to milliseconds", () => {
    expect(normalizeTimestamp(1_700_000_000)).toBe(1_700_000_000_000);
  });

  it("normalizes a single reported MAC for identity comparison", () => {
    expect(normalizeMac("00-11-22-33-44-55")).toBe("001122334455");
    expect(normalizeMac(["AA:BB:CC:DD:EE:FF"])).toBe("aabbccddeeff");
    expect(normalizeMac(undefined)).toBeNull();
    expect(normalizeMac("")).toBeNull();
    expect(normalizeMac("not-a-mac")).toBeNull();
  });
});

describe("Cortex matching", () => {
  it("matches a unique hostname without requiring a MAC", () => {
    expect(findCortexEndpoint(device, [endpoint()])?.endpoint_id).toBe(
      "cortex-1",
    );
    expect(
      findCortexEndpoint({ ...device, mac_address: undefined }, [endpoint()])
        ?.endpoint_id,
    ).toBe("cortex-1");
    expect(
      findCortexEndpoint({ ...device, mac_address: "aa:bb:cc:dd:ee:ff" }, [
        endpoint(),
      ])?.endpoint_id,
    ).toBe("cortex-1");
  });

  it("returns null when no hostname matches", () => {
    expect(
      findCortexEndpoint(device, [endpoint({ endpoint_name: "other-host" })]),
    ).toBeNull();
    expect(
      findCortexEndpoint({ ...device, hostname: undefined }, [endpoint()]),
    ).toBeNull();
  });

  it("disambiguates duplicate hostnames with the MAC address", () => {
    expect(
      findCortexEndpoint(device, [
        endpoint(),
        endpoint({ endpoint_id: "cortex-2", mac_address: ["aa:bb:cc:dd:ee:ff"] }),
      ])?.endpoint_id,
    ).toBe("cortex-1");
  });

  it("fails a duplicate hostname when the MAC cannot disambiguate", () => {
    expect(
      findCortexEndpoint(device, [
        endpoint(),
        endpoint({ endpoint_id: "cortex-2" }),
      ]),
    ).toBeNull();
    expect(
      findCortexEndpoint(
        { ...device, mac_address: undefined },
        [endpoint(), endpoint({ endpoint_id: "cortex-2" })],
      ),
    ).toBeNull();
    expect(
      findCortexEndpoint(
        { ...device, mac_address: "aa:bb:cc:dd:ee:ff" },
        [endpoint(), endpoint({ endpoint_id: "cortex-2" })],
      ),
    ).toBeNull();
  });
});

describe("posture evaluation", () => {
  it("passes protected endpoints with content under seven days", () => {
    expect(evaluateEndpoint(endpoint(), now, 7)).toEqual({
      score: 100,
      reason: "content_fresh",
    });
  });

  it("fails content older than seven days", () => {
    expect(
      evaluateEndpoint(
        endpoint({ last_content_update_time: now - 8 * 86_400_000 }),
        now,
        7,
      ),
    ).toEqual({ score: 0, reason: "content_older_than_allowed" });
  });

  it("ignores operational status", () => {
    expect(
      evaluateEndpoint(
        endpoint({ operational_status: "unprotected" }),
        now,
        7,
      ),
    ).toEqual({ score: 100, reason: "content_fresh" });
  });
});
