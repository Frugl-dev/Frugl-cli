import { CloudClient, CloudHttpError } from "../cloud/client.js";
import {
  orgMeResponseSchema,
  orgCreateResponseSchema,
  joinResponseSchema,
} from "../cloud/schemas.js";
import { PoppiError } from "../lib/errors.js";
import { EXIT } from "../lib/exit-codes.js";

export type OrgSetupAction =
  | { action: "create"; name: string; slug: string }
  | { action: "join"; code: string };

export type OrgSetupResult =
  | { status: "already-setup"; orgName: string; slug: string }
  | { status: "created"; orgName: string; slug: string }
  | { status: "joined"; orgName: string; slug: string }
  | { status: "slug-taken"; suggestion: string }
  | { status: "invalid-code" }
  | { status: "expired-code" };

export async function setupOrg(
  client: CloudClient,
  intent: OrgSetupAction,
): Promise<OrgSetupResult> {
  // Check current membership first.
  try {
    const me = await client.call({
      method: "GET",
      path: "/api/orgs/me",
      schema: orgMeResponseSchema,
    });
    return { status: "already-setup", orgName: me.org.name, slug: me.org.slug };
  } catch (err) {
    if (!(err instanceof CloudHttpError && err.status === 409)) throw err;
    // 409 org_required → proceed with setup
  }

  if (intent.action === "create") {
    try {
      const created = await client.call({
        method: "POST",
        path: "/api/orgs/create",
        body: { name: intent.name, slug: intent.slug },
        schema: orgCreateResponseSchema,
      });
      return { status: "created", orgName: created.name, slug: created.slug };
    } catch (err) {
      if (err instanceof CloudHttpError && err.status === 409) {
        const body = err.body as Record<string, unknown>;
        if (body?.error === "slug_taken") {
          const suggestion = (body?.details as Record<string, unknown>)?.suggestion as string;
          return { status: "slug-taken", suggestion };
        }
      }
      throw err;
    }
  }

  // action === "join"
  try {
    const joined = await client.call({
      method: "POST",
      path: "/api/join",
      body: { code: intent.code },
      schema: joinResponseSchema,
    });
    return { status: "joined", orgName: joined.org.name, slug: joined.org.slug };
  } catch (err) {
    if (err instanceof CloudHttpError) {
      if (err.status === 404) return { status: "invalid-code" };
      if (err.status === 410) return { status: "expired-code" };
      if (err.status === 429) {
        const body = err.body as Record<string, unknown>;
        const retry = (body?.details as Record<string, unknown>)?.retry_after_seconds;
        throw new PoppiError(
          `Too many attempts. Try again in ${retry ?? "a few"} seconds.`,
          EXIT.GENERIC_FAILURE,
        );
      }
    }
    throw err;
  }
}
