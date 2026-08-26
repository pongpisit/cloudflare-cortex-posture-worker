import {
  SignJWT,
  exportJWK,
  generateKeyPair,
  importJWK,
  jwtVerify,
} from "jose";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  evaluateExternalRequest,
  getExternalEvaluationKeys,
} from "../src/external-evaluation";

afterEach(() => vi.restoreAllMocks());

describe("Access External Evaluation", () => {
  it("verifies the request and signs a nonce-bound posture decision", async () => {
    const accessKeys = await generateKeyPair("RS256", { extractable: true });
    const resultKeys = await generateKeyPair("RS256", { extractable: true });
    const accessPublicJwk = await exportJWK(accessKeys.publicKey);
    const resultPrivateJwk = await exportJWK(resultKeys.privateKey);
    accessPublicJwk.kid = "access-key";
    resultPrivateJwk.kid = "result-key";

    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      Response.json({ keys: [accessPublicJwk] }),
    );
    const db = Object.create(null) as D1Database;
    const statement = Object.create(null) as D1PreparedStatement;
    statement.bind = () => statement;
    const row = {
      cloudflare_device_id: "cf-device-1",
      cortex_endpoint_id: "cortex-1",
      score: 100,
      reason: "protected_and_content_fresh",
      cortex_refreshed_at: Date.now(),
      hostname: "laptop-001",
      verified_mac: "001122334455",
      serial_number: "serial-1",
    };
    statement.all = async <T = Record<string, unknown>>() => ({
      results: [row as T],
      success: true,
      meta: {
        duration: 0,
        size_after: 0,
        rows_read: 1,
        rows_written: 0,
        last_row_id: 0,
        changed_db: false,
        changes: 0,
      },
    });
    db.prepare = () => statement;
    const env = {
      ACCESS_TEAM_DOMAIN: "https://example.cloudflareaccess.com",
      EXTERNAL_EVAL_AUDS: "protected-app-aud",
      EXTERNAL_EVAL_MAPPING_MAX_AGE_MINUTES: "30",
      DB: db,
      EXTERNAL_EVAL_PRIVATE_JWK: JSON.stringify(resultPrivateJwk),
    };
    const requestToken = await new SignJWT({
      nonce: "request-nonce",
      identity: { device_id: "cf-device-1" },
    })
      .setProtectedHeader({ alg: "RS256", kid: "access-key" })
      .setAudience("protected-app-aud")
      .setIssuedAt()
      .setExpirationTime("5m")
      .sign(accessKeys.privateKey);

    const response = await evaluateExternalRequest(
      { token: requestToken },
      env,
    );
    const body = await response.json<{ token: string }>();
    const resultPublicJwk = await exportJWK(resultKeys.publicKey);
    const { payload } = await jwtVerify(
      body.token,
      await importJWK(resultPublicJwk, "RS256"),
    );

    expect(response.status).toBe(200);
    expect(payload.success).toBe(true);
    expect(payload.nonce).toBe("request-nonce");

    const keysResponse = await getExternalEvaluationKeys(env);
    const keysBody = await keysResponse.json<{ keys: Array<Record<string, unknown>> }>();
    expect(keysBody.keys[0]).toMatchObject({
      kty: "RSA",
      kid: "result-key",
      n: resultPrivateJwk.n,
      e: resultPrivateJwk.e,
    });
    expect(keysBody.keys[0]).not.toHaveProperty("d");

    const wrongAudienceToken = await new SignJWT({
      nonce: "wrong-audience-nonce",
      identity: { device_id: "cf-device-1" },
    })
      .setProtectedHeader({ alg: "RS256", kid: "access-key" })
      .setAudience("different-app-aud")
      .setIssuedAt()
      .setExpirationTime("5m")
      .sign(accessKeys.privateKey);
    const rejected = await evaluateExternalRequest(
      { token: wrongAudienceToken },
      env,
    );
    expect(rejected.status).toBe(403);
  });
});
