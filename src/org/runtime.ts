import { CloudClient, CloudHttpError } from "../cloud/client.js";
import { resolveEndpoint, type Endpoint } from "../cloud/endpoints.js";
import { requireAuthSession, type AuthSession } from "../auth/session.js";
import { orgMeResponseSchema } from "../cloud/schemas.js";
import { getCliVersion } from "../lib/cli-version.js";

export interface OrgRuntime {
  client: CloudClient;
  session: AuthSession;
  endpoint: Endpoint;
}

// Resolve endpoint + require a stored session + build an authed client. Throws
// AuthError (→ exit 10) when not logged in, matching whoami/upload.
export async function authedClient(endpointFlag: string | undefined): Promise<OrgRuntime> {
  const endpoint = resolveEndpoint({
    flag: endpointFlag,
    env: process.env["POPPI_ENDPOINT"],
  });
  const session = await requireAuthSession(endpoint.url);
  const client = new CloudClient({
    endpointUrl: endpoint.url,
    cliVersion: getCliVersion(),
    token: session.token,
    endpointExplicit: endpoint.resolvedFrom !== "default",
  });
  return { client, session, endpoint };
}

export type OrgContext =
  | { kind: "member"; slug: string; name: string; role: string; memberCount?: number }
  | { kind: "none" };

// GET /api/orgs/me, modelling 409 "org_required" as data (kind: "none") rather
// than an error, so callers apply their own policy. Other errors propagate.
export async function fetchOrgContext(client: CloudClient): Promise<OrgContext> {
  try {
    const me = await client.call({
      method: "GET",
      path: "/api/orgs/me",
      schema: orgMeResponseSchema,
    });
    return {
      kind: "member",
      slug: me.org.slug,
      name: me.org.name,
      role: me.membership.role,
      ...(me.org.member_count !== undefined ? { memberCount: me.org.member_count } : {}),
    };
  } catch (err) {
    if (err instanceof CloudHttpError && err.status === 409) return { kind: "none" };
    throw err;
  }
}
