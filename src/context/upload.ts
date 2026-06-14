import { randomUUID } from "node:crypto";
import { withRetry } from "../lib/retry.js";
import type { AnonymizationResult } from "../anonymize/index.js";
import type { UploadCloudPort } from "../upload/cloud-port.js";

// The format_version stamped on a context snapshot manifest entry. Distinct from
// the per-source session format versions so the cloud can route the parse path.
export const CONTEXT_FORMAT_VERSION = "context/v1";

export interface ContextUploadInput {
  cloud: UploadCloudPort;
  cliVersion: string;
  sourceKind: string;
  policyVersion: string;
  capturedAt: string;
  anonymization: AnonymizationResult;
  // Declared MCP server inventory (names-only, fail-open) recorded on the
  // upload row server-side; omitted when the capture failed or found nothing.
  mcpServers?: { name: string; status: "connected" | "failed" | "pending" | "unknown" }[];
}

export type ContextUploadResult =
  // The snapshot was uploaded and parsed.
  | { status: "uploaded"; manifestId: string; sessionId: string; dashboardUrl: string }
  // The capture was identical to the user's latest snapshot — the server
  // skipped the upload (spec 052) and nothing left the machine.
  | { status: "no_change" }
  // The user is at their weekly snapshot cap — the server refused it; nothing
  // was uploaded.
  | { status: "cap_reached"; cap: number; used: number; windowResetsAt: string };

// Run the manifest -> presign -> PUT -> complete handshake for a single context
// snapshot. Unlike the session pipeline there is no resume/ledger: each run mints
// a fresh uuid v4 + uses the capture timestamp, so re-invoking after a failure
// simply starts a brand-new manifest (no partial state to clean up, safe to
// re-run — the fail-closed re-invocation guarantee).
//
// The manifest carries a content_hash (spec 052) so the server can skip an
// unchanged capture before any bytes are sent; it may also refuse the upload
// when the user is over their weekly cap. Both short-circuit before presign.
export async function uploadContextSnapshot(
  input: ContextUploadInput,
): Promise<ContextUploadResult> {
  const sessionId = randomUUID();
  // The PUT body is the anonymized stdout TEXT bytes (UTF-8), not JSON-wrapped.
  const body = Buffer.from(String(input.anonymization.payload), "utf8");

  const manifest = await input.cloud.createManifest({
    cli_version: input.cliVersion,
    redaction_policy_version: input.policyVersion,
    source_kind: input.sourceKind,
    expected_session_count: 1,
    artifact_kind: "context_snapshot",
    ...(input.mcpServers?.length ? { mcp_servers: input.mcpServers } : {}),
    sessions: [
      {
        session_id: sessionId,
        format_version: CONTEXT_FORMAT_VERSION,
        expected_bytes: input.anonymization.byteSize,
        captured_at: input.capturedAt,
        // The no-change fingerprint: stable across runs, independent of the
        // per-run uploadId and the capture timestamp (anonymize/index.ts).
        content_hash: input.anonymization.contentHashHex,
      },
    ],
  });

  // The gate decided before any upload: a skipped or capped run sends no bytes.
  if (manifest.kind === "no_change") return { status: "no_change" };
  if (manifest.kind === "cap_reached") {
    return {
      status: "cap_reached",
      cap: manifest.cap,
      used: manifest.used,
      windowResetsAt: manifest.windowResetsAt,
    };
  }
  const { uploadId } = manifest;

  // Presign + PUT under a single retry so a transient PUT failure re-presigns and
  // retries the whole pair, exactly as the session pipeline does.
  await withRetry(async () => {
    const presigned = await input.cloud.presign(uploadId, sessionId);
    await input.cloud.putSessionBody(presigned.url, body, { ...presigned.headers });
  });

  const complete = await input.cloud.completeManifest(
    uploadId,
    filterPositive(input.anonymization.redactionsByCategory),
  );

  return {
    status: "uploaded",
    manifestId: complete.manifestId,
    sessionId,
    dashboardUrl: complete.dashboardUrl,
  };
}

function filterPositive(counts: Record<string, number>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(counts)) {
    if (v > 0) out[k] = v;
  }
  return out;
}
