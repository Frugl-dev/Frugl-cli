import { CloudClient } from "../cloud/client.js";
import { identityResponseSchema, type IdentityResponse } from "../cloud/schemas.js";
import { getCliVersion } from "../lib/cli-version.js";
import { AuthError } from "../lib/errors.js";
import { loadAuthSession, type AuthSession } from "./session.js";
import { resolveHeadlessToken } from "./token-auth.js";

export interface ResolveUploadAuthOptions {
  endpointUrl: string;
  endpointExplicit: boolean;
  flagToken?: string | undefined;
  /** Injectable for tests; defaults to process.env. */
  env?: NodeJS.ProcessEnv;
}

// Resolves the identity + token for an upload WITHOUT ever performing
// interactive OTP login. Order:
//   1. an explicit headless token (--token / POPPI_TOKEN), whose identity is
//      resolved from the server (works for a human or an org service identity);
//   2. otherwise a stored keychain session from `poppi login`.
// Throws AuthError when neither is available (a non-interactive run then exits
// non-zero rather than prompting).
export async function resolveUploadAuth(opts: ResolveUploadAuthOptions): Promise<AuthSession> {
  const resolved = await resolveHeadlessToken({
    flagToken: opts.flagToken,
    endpointUrl: opts.endpointUrl,
    env: opts.env,
  });

  if (!resolved) {
    throw new AuthError(
      "Not logged in. Provide a token via --token or POPPI_TOKEN, or run 'poppi login'.",
    );
  }

  if (resolved.source === "session") {
    const session = await loadAuthSession(opts.endpointUrl);
    if (!session) {
      throw new AuthError("Not logged in. Run 'poppi login' or set POPPI_TOKEN.");
    }
    return session;
  }

  const identity = await fetchIdentity(opts.endpointUrl, opts.endpointExplicit, resolved.token);
  return {
    email: identity.primary_email,
    userId: identity.user_id,
    token: resolved.token,
    endpointUrl: opts.endpointUrl,
    loggedInAt: new Date().toISOString(),
  };
}

// Looks up the acting identity for a bearer token via GET /api/auth/whoami.
// A 401/403 (invalid/revoked token) surfaces as AuthError from CloudClient.
export async function fetchIdentity(
  endpointUrl: string,
  endpointExplicit: boolean,
  token: string,
): Promise<IdentityResponse> {
  const client = new CloudClient({
    endpointUrl,
    cliVersion: getCliVersion(),
    token,
    endpointExplicit,
  });
  return client.call({ method: "GET", path: "/api/auth/whoami", schema: identityResponseSchema });
}
