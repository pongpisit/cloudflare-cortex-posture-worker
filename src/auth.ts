import { createRemoteJWKSet, jwtVerify } from "jose";

export class AuthenticationError extends Error {}

export async function validateAccessRequest(
  request: Request,
  env: Env,
): Promise<void> {
  if (env.AUTH_MODE !== "access") {
    throw new AuthenticationError("Access authentication is not enabled");
  }

  if (
    !env.ACCESS_TEAM_DOMAIN ||
    env.ACCESS_TEAM_DOMAIN.includes("replace-me") ||
    !env.ACCESS_AUD ||
    env.ACCESS_AUD.startsWith("replace-")
  ) {
    throw new Error("Cloudflare Access authentication is not configured");
  }

  const token = request.headers.get("cf-access-jwt-assertion");
  if (!token) {
    throw new AuthenticationError("Missing Cloudflare Access JWT");
  }

  const issuer = env.ACCESS_TEAM_DOMAIN.replace(/\/+$/, "");
  const jwks = createRemoteJWKSet(
    new URL(`${issuer}/cdn-cgi/access/certs`),
  );

  try {
    await jwtVerify(token, jwks, {
      issuer,
      audience: env.ACCESS_AUD,
      algorithms: ["RS256"],
    });
  } catch {
    throw new AuthenticationError("Invalid Cloudflare Access JWT");
  }
}
