import { describe, expect, it } from "vitest";
import {
  classifyIdentity,
  coverageSummary,
  evaluateEndpoint,
  needsMacsUnion,
  normalizeHostname,
  normalizeMac,
  normalizeMacCollection,
  normalizeTimestamp,
  parseVerifiedMacs,
  isJunkSerial,
  resolveCortexEndpoint,
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

  it("parses the verified MAC set with legacy fallback", () => {
    expect(
      [...parseVerifiedMacs('["001122334455","aabbccddeeff"]', null)].sort(),
    ).toEqual(["001122334455", "aabbccddeeff"]);
    expect([...parseVerifiedMacs(null, "00-11-22-33-44-55")]).toEqual([
      "001122334455",
    ]);
    expect([...parseVerifiedMacs(null, null)]).toEqual([]);
    expect([...parseVerifiedMacs("{corrupt", "00-11-22-33-44-55")]).toEqual([
      "001122334455",
    ]);
    expect([...parseVerifiedMacs('["not-a-mac"]', null)]).toEqual([]);
  });
});

describe("binding identity drift", () => {
  const MAC_A = "00:11:22:33:44:55";
  const MAC_B = "aa:bb:cc:dd:ee:ff";
  const stored = {
    hostname: "laptop-001",
    verifiedMacs: new Set(["001122334455", "aabbccddeeff"]),
  };

  it("stays confirmed for any subset of a multi-NIC MAC set", () => {
    // Regression for the churn loop: comparing the first reported MAC against
    // a single stored MAC invalidated multi-NIC machines on every poll.
    expect(classifyIdentity(device, stored)).toBe("confirmed");
    expect(
      classifyIdentity({ ...device, mac_address: [MAC_B] }, stored),
    ).toBe("confirmed");
    expect(
      classifyIdentity({ ...device, mac_address: [MAC_B, MAC_A] }, stored),
    ).toBe("confirmed");
    expect(
      classifyIdentity(
        { ...device, mac_address: ["ff:ee:dd:cc:bb:aa", MAC_A] },
        stored,
      ),
    ).toBe("confirmed");
  });

  it("flags mac drift only when every reported MAC is unknown", () => {
    expect(
      classifyIdentity(
        { ...device, mac_address: "ff-ee-dd-cc-bb-aa" },
        stored,
      ),
    ).toBe("mac_drift");
    expect(
      classifyIdentity(
        { ...device, mac_address: ["ff:ee:dd:cc:bb:aa", MAC_B] },
        stored,
      ),
    ).toBe("confirmed");
  });

  it("never reports mac drift without evidence on both sides", () => {
    expect(
      classifyIdentity({ ...device, mac_address: "ff-ee-dd-cc-bb-aa" }, {
        hostname: "laptop-001",
        verifiedMacs: new Set<string>(),
      }),
    ).toBe("confirmed");
    expect(
      classifyIdentity({ ...device, mac_address: undefined }, stored),
    ).toBe("confirmed");
  });

  it("flags hostname drift when the rename keeps MAC evidence", () => {
    expect(
      classifyIdentity({ ...device, hostname: "laptop-002" }, stored),
    ).toBe("hostname_drift");
  });

  it("flags a replacement when hostname and MAC change together", () => {
    expect(
      classifyIdentity(
        { ...device, hostname: "laptop-002", mac_address: "ff-ee-dd-cc-bb-aa" },
        stored,
      ),
    ).toBe("replaced");
  });

  it("absorbs newly observed MACs only alongside a known MAC", () => {
    const setA = new Set(["001122334455"]);
    expect(
      needsMacsUnion(setA, normalizeMacCollection([MAC_A])),
    ).toBe(false);
    expect(
      needsMacsUnion(setA, normalizeMacCollection([MAC_A, MAC_B])),
    ).toBe(true);
    expect(
      needsMacsUnion(setA, normalizeMacCollection([MAC_B])),
    ).toBe(false);
    expect(
      needsMacsUnion(new Set<string>(), normalizeMacCollection([MAC_B])),
    ).toBe(true);
    expect(needsMacsUnion(setA, normalizeMacCollection(undefined))).toBe(false);
  });
});

describe("serial integrity", () => {
  it("flags OEM junk and placeholder serials", () => {
    expect(isJunkSerial("Default String")).toBe(true);
    expect(isJunkSerial(" System Serial Number ")).toBe(true);
    expect(isJunkSerial("To Be Filled By O.E.M.")).toBe(true);
    expect(isJunkSerial("none")).toBe(true);
    expect(isJunkSerial("0000000")).toBe(true);
    expect(isJunkSerial("000")).toBe(true);
    expect(isJunkSerial(null)).toBe(true);
  });

  it("accepts real serials", () => {
    expect(isJunkSerial("VMware-56 4d 4a e5 a7 53 b9 01")).toBe(false);
    expect(isJunkSerial("C02XK1QGJG5H")).toBe(false);
    expect(isJunkSerial("JD4NX12345")).toBe(false);
  });
});

describe("Cortex matching", () => {
  it("binds a unique hostname match, corroborating with the MAC when both sides agree", () => {
    const unique = resolveCortexEndpoint(device, [endpoint()], now);
    expect(unique.status).toBe("bound");
    expect(unique.endpoint?.endpoint_id).toBe("cortex-1");
    expect(unique.method).toBe("mac");

    const noEvidence = resolveCortexEndpoint(
      { ...device, mac_address: undefined },
      [endpoint()],
      now,
    );
    expect(noEvidence.status).toBe("bound");
    expect(noEvidence.method).toBe("hostname");

    const differingMac = resolveCortexEndpoint(
      { ...device, mac_address: "aa:bb:cc:dd:ee:ff" },
      [endpoint()],
      now,
    );
    // A disjoint MAC never rules out a unique-hostname match: the two systems
    // may each name a different adapter of the same machine.
    expect(differingMac.status).toBe("bound");
    expect(differingMac.method).toBe("hostname");
  });

  it("returns no_match when no hostname matches", () => {
    expect(
      resolveCortexEndpoint(
        device,
        [endpoint({ endpoint_name: "other-host" })],
        now,
      ).status,
    ).toBe("no_match");
    expect(
      resolveCortexEndpoint({ ...device, hostname: undefined }, [endpoint()], now)
        .status,
    ).toBe("no_match");
  });

  it("disambiguates duplicate hostnames with the MAC address", () => {
    const result = resolveCortexEndpoint(
      device,
      [endpoint(), endpoint({ endpoint_id: "cortex-2", mac_address: ["aa:bb:cc:dd:ee:ff"] })],
      now,
    );
    expect(result.status).toBe("bound");
    expect(result.endpoint?.endpoint_id).toBe("cortex-1");
    expect(result.method).toBe("mac");
  });

  it("refuses a duplicate hostname the MAC cannot disambiguate", () => {
    const twins = [
      endpoint(),
      endpoint({ endpoint_id: "cortex-2" }),
    ];
    expect(
      resolveCortexEndpoint(device, twins, now).status,
    ).toBe("ambiguous");
    expect(
      resolveCortexEndpoint(
        { ...device, mac_address: undefined },
        twins,
        now,
      ).status,
    ).toBe("ambiguous");
    expect(
      resolveCortexEndpoint(
        { ...device, mac_address: "ff:00:00:00:00:99" },
        twins,
        now,
      ).status,
    ).toBe("ambiguous");
  });

  it("liveness-prunes dead duplicate records to a unique hostname bind", () => {
    const deadTwin = endpoint({
      endpoint_id: "cortex-dead",
      mac_address: ["aa:bb:cc:dd:ee:ff"],
      last_seen: now - 60 * 86_400_000,
    });
    const result = resolveCortexEndpoint(
      { ...device, mac_address: undefined },
      [endpoint(), deadTwin],
      now,
    );
    expect(result.status).toBe("bound");
    expect(result.endpoint?.endpoint_id).toBe("cortex-1");
    expect(result.method).toBe("hostname");
  });

  it("requires MAC corroboration when the strict setting is on", () => {
    const strict = resolveCortexEndpoint(device, [endpoint()], now, {
      requireMac: true,
    });
    expect(strict.status).toBe("bound");
    expect(strict.method).toBe("mac");

    const hostnameOnly = resolveCortexEndpoint(
      { ...device, mac_address: undefined },
      [endpoint()],
      now,
      { requireMac: true },
    );
    expect(hostnameOnly.status).toBe("mac_required");
  });
});

describe("coverage summary", () => {
  it("reports full coverage when every endpoint is mapped", () => {
    expect(
      coverageSummary(
        [endpoint(), endpoint({ endpoint_id: "cortex-2" })],
        new Set(["cortex-1", "cortex-2"]),
      ),
    ).toEqual({ scanned: 2, covered: 2, uncovered: 0, coveragePercent: 100 });
  });

  it("reports partial coverage with one decimal", () => {
    expect(
      coverageSummary(
        [endpoint(), endpoint({ endpoint_id: "cortex-2" }), endpoint({ endpoint_id: "cortex-3" })],
        new Set(["cortex-2"]),
      ),
    ).toEqual({ scanned: 3, covered: 1, uncovered: 2, coveragePercent: 33.3 });
  });

  it("reports null coverage for an empty scan", () => {
    expect(coverageSummary([], new Set())).toEqual({
      scanned: 0,
      covered: 0,
      uncovered: 0,
      coveragePercent: null,
    });
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
