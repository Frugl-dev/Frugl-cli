import { CloudHttpError, type CloudClient } from "./client.js";
import { handoffRequestSchema, handoffResponseSchema } from "./schemas.js";
import { AuthError } from "../lib/errors.js";
import type { OutputMode } from "../lib/output-mode.js";

// CLI→web session handoff (spec 006): after a successful upload, mint a
// single-use ~60s sign-in code and append it to the dashboard URL so the
// browser lands signed in. This module is a TOTAL FUNCTION over every failure
// mode — the upload has already succeeded, so nothing here may throw, retry,
// or change the exit code (FR-008); failures degrade to the plain URL with an
// honest reason.

export type HandoffSkipReason =
  | "disabled-flag" // --no-handoff
  | "disabled-default" // non-interactive run, no explicit opt-in (FR-011)
  | "unsupported" // 404/405 — endpoint not deployed (older cloud)
  | "unavailable" // timeout, network, 429, 5xx, 426, schema mismatch
  | "rejected"; // other 4xx (invalid redirect, auth)

export type HandoffResult =
  | { active: true; dashboardUrl: string; expiresAt: string }
  | { active: false; dashboardUrl: string; reason: HandoffSkipReason };

export interface HandoffPreference {
  active: boolean;
  source: "flag" | "default";
}

// The handoff call is a post-success convenience: hard-capped well below the
// control-plane default and never retried (research R-7).
export const HANDOFF_TIMEOUT_MS = 3_000;

// Precedence (research R-5): explicit flag wins; otherwise on only for
// interactive default-format runs — the json/minimal formats, piped stdout, and
// CI default off so printed output never carries credential material
// unrequested (FR-010/011).
export function resolveHandoffPreference(
  flagValue: boolean | undefined,
  isTTY: boolean,
  mode: OutputMode,
): HandoffPreference {
  if (flagValue === false) return { active: false, source: "flag" };
  if (flagValue === true) return { active: true, source: "flag" };
  return { active: isTTY && mode === "default", source: "default" };
}

// The narrow slice of CloudClient this module needs — keeps unit tests free of
// HTTP (mirrors the UploadCloudPort posture without widening that port, R-6).
export type HandoffClient = Pick<CloudClient, "call">;

export async function requestHandoffUrl(
  client: HandoffClient,
  dashboardUrl: string,
  preference: HandoffPreference,
): Promise<HandoffResult> {
  if (!preference.active) {
    return {
      active: false,
      dashboardUrl,
      reason: preference.source === "flag" ? "disabled-flag" : "disabled-default",
    };
  }

  // redirect_to is the server-authored dashboard destination, path+query only
  // (never host) — the relative-path refinement is the open-redirect guard.
  let target: URL;
  try {
    target = new URL(dashboardUrl);
  } catch {
    return { active: false, dashboardUrl, reason: "rejected" };
  }
  const body = handoffRequestSchema.safeParse({
    redirect_to: `${target.pathname}${target.search}`,
  });
  if (!body.success) {
    return { active: false, dashboardUrl, reason: "rejected" };
  }

  try {
    const grant = await client.call({
      method: "POST",
      path: "/api/auth/handoff",
      body: body.data,
      schema: handoffResponseSchema,
      timeoutMs: HANDOFF_TIMEOUT_MS,
    });
    const decorated = new URL(dashboardUrl);
    decorated.searchParams.set("handoff", grant.code);
    return { active: true, dashboardUrl: decorated.toString(), expiresAt: grant.expires_at };
  } catch (err) {
    return { active: false, dashboardUrl, reason: toSkipReason(err) };
  }
}

// Status → reason per contracts/handoff-api.md. CloudClient pre-maps some
// statuses to typed errors before CloudHttpError is reachable: 401/403 →
// AuthError (rejected), 426 → VersionGateError, zod/JSON mismatch →
// FruglError — both land in the `unavailable` fallback alongside
// NetworkError/EndpointError/timeouts.
function toSkipReason(err: unknown): HandoffSkipReason {
  if (err instanceof AuthError) return "rejected";
  if (err instanceof CloudHttpError) {
    if (err.status === 404 || err.status === 405) return "unsupported";
    if (err.status >= 400 && err.status < 500 && err.status !== 429) return "rejected";
  }
  return "unavailable";
}
