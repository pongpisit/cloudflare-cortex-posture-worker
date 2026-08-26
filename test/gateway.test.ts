import { describe, expect, it } from "vitest";
import { evaluateGatewayContext, parseGatewayContext } from "../src/gateway";

const context = {
  src_ip: "100.96.0.10",
  src_port: 51_234,
  dst_ip: "192.0.2.10",
  dst_port: 443,
  protocol: "tcp",
  detected_protocol: "tls",
  sni: "internal.example.com",
  vnet_id: null,
  proxy_endpoint: null,
  account_tag: "account-tag",
};

describe("Gateway custom function context", () => {
  it("accepts direct and wrapped contexts", () => {
    expect(parseGatewayContext(context)).toEqual(context);
    expect(parseGatewayContext({ context })).toEqual(context);
  });

  it("rejects incomplete or invalid contexts", () => {
    expect(parseGatewayContext({ ...context, src_ip: "" })).toBeNull();
    expect(parseGatewayContext({ ...context, dst_port: 70_000 })).toBeNull();
  });

  it("returns a successful fail-closed result for invalid input and D1 errors", async () => {
    const db = Object.create(null) as D1Database;
    db.prepare = () => {
      throw new Error("D1 unavailable");
    };

    const invalid = await evaluateGatewayContext(context, {
      DB: db,
      GATEWAY_ACCOUNT_TAG: "different-account",
      GATEWAY_IP_MAX_AGE_MINUTES: "30",
    });
    const failedLookup = await evaluateGatewayContext(context, {
      DB: db,
      GATEWAY_ACCOUNT_TAG: "account-tag",
      GATEWAY_IP_MAX_AGE_MINUTES: "30",
    });

    expect(invalid.status).toBe(200);
    await expect(invalid.json()).resolves.toEqual({ result: 0 });
    expect(failedLookup.status).toBe(200);
    await expect(failedLookup.json()).resolves.toEqual({ result: 0 });
  });
});
