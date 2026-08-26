import {
  SignJWT,
  calculateJwkThumbprint,
  createRemoteJWKSet,
  importJWK,
  jwtVerify,
  type JWK,
  type JWTPayload,
} from "jose";
import { getStoredEvaluations } from "./repository";

const accessJwks = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

interface ExternalEvaluationClaims extends JWTPayload {
  identity?: { device_id?: unknown };
  nonce?: unknown;
}

interface RsaPrivateJwk extends JWK {
  kty: "RSA";
  n: string;
  e: string;
  d: string;
}

type ExternalEvaluationEnv = {
  ACCESS_TEAM_DOMAIN: string;
  EXTERNAL_EVAL_AUDS: string;
  EXTERNAL_EVAL_MAPPING_MAX_AGE_MINUTES: string;
  DB: D1Database;
  EXTERNAL_EVAL_PRIVATE_JWK?: string;
};

export async function getExternalEvaluationKeys(
  env: ExternalEvaluationEnv,
): Promise<Response> {
  const { privateJwk, kid } = await signingKey(env);
  return Response.json(
    {
      keys: [
        {
          kty: "RSA",
          n: privateJwk.n,
          e: privateJwk.e,
          alg: "RS256",
          use: "sig",
          kid,
        },
      ],
    },
    { headers: { "cache-control": "public, max-age=300" } },
  );
}

export async function evaluateExternalRequest(
  body: unknown,
  env: ExternalEvaluationEnv,
): Promise<Response> {
  try {
    if (!isRecord(body) || typeof body.token !== "string") {
      throw new Error("token_required");
    }

    const claims = await verifyRequestToken(body.token, env);
    const nonce = claims.nonce;
    if (typeof nonce !== "string" || nonce.length === 0 || nonce.length > 256) {
      throw new Error("invalid_nonce");
    }

    const rawDeviceId = claims.identity?.device_id;
    const deviceId =
      typeof rawDeviceId === "string" && rawDeviceId.length <= 128
        ? rawDeviceId
        : "";
    const configuredAge = Number(env.EXTERNAL_EVAL_MAPPING_MAX_AGE_MINUTES);
    const maximumAgeMinutes =
      Number.isFinite(configuredAge) && configuredAge > 0 ? configuredAge : 30;
    const evaluations = deviceId
      ? await getStoredEvaluations(
          env.DB,
          [deviceId],
          Date.now() - maximumAgeMinutes * 60_000,
        )
      : new Map();
    const success = evaluations.get(deviceId)?.score === 100;
    const token = await signResult({ success, nonce }, env);

    return Response.json(
      { token },
      { headers: { "cache-control": "no-store" } },
    );
  } catch (error) {
    console.warn(
      JSON.stringify({
        event: "external_evaluation_rejected",
        error: error instanceof Error ? error.message : String(error),
      }),
    );
    return Response.json({ error: "external_evaluation_rejected" }, { status: 403 });
  }
}

async function verifyRequestToken(
  token: string,
  env: ExternalEvaluationEnv,
): Promise<ExternalEvaluationClaims> {
  const issuer = env.ACCESS_TEAM_DOMAIN.replace(/\/+$/, "");
  if (!issuer || issuer.includes("replace-me")) {
    throw new Error("access_team_domain_not_configured");
  }
  let jwks = accessJwks.get(issuer);
  if (!jwks) {
    jwks = createRemoteJWKSet(new URL(`${issuer}/cdn-cgi/access/certs`));
    accessJwks.set(issuer, jwks);
  }
  const audiences = env.EXTERNAL_EVAL_AUDS.split(",")
    .map((value) => value.trim())
    .filter((value) => value && !value.startsWith("replace-"));
  if (audiences.length === 0) {
    throw new Error("external_evaluation_audience_not_configured");
  }
  const { payload } = await jwtVerify(token, jwks, {
    algorithms: ["RS256"],
    audience: audiences,
    clockTolerance: 5,
  });
  return payload as ExternalEvaluationClaims;
}

async function signResult(
  payload: { success: boolean; nonce: string },
  env: ExternalEvaluationEnv,
): Promise<string> {
  const { privateJwk, kid } = await signingKey(env);
  const key = await importJWK(privateJwk, "RS256");
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT(payload)
    .setProtectedHeader({ alg: "RS256", kid, typ: "JWT" })
    .setIssuedAt(now)
    .setExpirationTime(now + 60)
    .sign(key);
}

async function signingKey(
  env: ExternalEvaluationEnv,
): Promise<{ privateJwk: RsaPrivateJwk; kid: string }> {
  const raw = env.EXTERNAL_EVAL_PRIVATE_JWK;
  if (!raw) throw new Error("external_evaluation_key_not_configured");

  const parsed = JSON.parse(raw) as unknown;
  if (
    !isRecord(parsed) ||
    parsed.kty !== "RSA" ||
    typeof parsed.n !== "string" ||
    typeof parsed.e !== "string" ||
    typeof parsed.d !== "string"
  ) {
    throw new Error("invalid_external_evaluation_key");
  }
  const privateJwk = parsed as unknown as RsaPrivateJwk;
  const kid =
    typeof parsed.kid === "string" && parsed.kid
      ? parsed.kid
      : await calculateJwkThumbprint(privateJwk, "sha256");
  return { privateJwk, kid };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
