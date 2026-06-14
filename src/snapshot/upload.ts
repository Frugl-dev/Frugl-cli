import { randomUUID } from "node:crypto";
import { withRetry } from "../lib/retry.js";
import type { UploadCloudPort } from "../upload/cloud-port.js";

// The snapshot artifact kinds that flow this single-entry handshake. Both mint a
// fresh uuid + carry a capture timestamp and have no resume/ledger: re-invoking
// after a failure simply starts a brand-new manifest (the fail-closed
// re-invocation guarantee). Distinct from "session", which the durable pipeline
// owns.
export type SnapshotArtifactKind = "context_snapshot" | "mcp_snapshot";

export interface SnapshotUploadInput {
  cloud: UploadCloudPort;
  cliVersion: string;
  sourceKind: string;
  policyVersion: string;
  capturedAt: string;
  artifactKind: SnapshotArtifactKind;
  // format_version stamped on the manifest entry so the cloud can route the
  // parse path (e.g. "context/v1", "mcp/v1").
  formatVersion: string;
  // The already-anonymized PUT body bytes.
  body: Buffer;
  // Bytes declared on the manifest entry (expected_bytes).
  expectedBytes: number;
  redactionsByCategory: Record<string, number>;
  // Declared MCP server inventory (names-only, fail-open) recorded on the upload
  // row server-side; omitted when the capture failed or found nothing.
  mcpServers?: { name: string; status: "connected" | "failed" | "pending" | "unknown" }[];
}

export interface SnapshotUploadResult {
  manifestId: string;
  sessionId: string;
  dashboardUrl: string;
}

// Run the manifest -> presign -> PUT -> complete handshake for a single snapshot
// artifact. Unlike the session pipeline there is no resume/ledger: each run mints
// a fresh uuid v4 + uses the capture timestamp, so re-invoking after a failure
// simply starts a brand-new manifest (no partial state to clean up, safe to
// re-run).
export async function uploadSnapshot(input: SnapshotUploadInput): Promise<SnapshotUploadResult> {
  const sessionId = randomUUID();

  const { uploadId } = await input.cloud.createManifest({
    cli_version: input.cliVersion,
    redaction_policy_version: input.policyVersion,
    source_kind: input.sourceKind,
    expected_session_count: 1,
    artifact_kind: input.artifactKind,
    ...(input.mcpServers?.length ? { mcp_servers: input.mcpServers } : {}),
    sessions: [
      {
        session_id: sessionId,
        format_version: input.formatVersion,
        expected_bytes: input.expectedBytes,
        captured_at: input.capturedAt,
      },
    ],
  });

  // Presign + PUT under a single retry so a transient PUT failure re-presigns and
  // retries the whole pair, exactly as the session pipeline does.
  await withRetry(async () => {
    const presigned = await input.cloud.presign(uploadId, sessionId);
    await input.cloud.putSessionBody(presigned.url, input.body, { ...presigned.headers });
  });

  const complete = await input.cloud.completeManifest(
    uploadId,
    filterPositive(input.redactionsByCategory),
  );

  return {
    manifestId: complete.manifestId,
    sessionId,
    dashboardUrl: complete.dashboardUrl,
  };
}

export function filterPositive(counts: Record<string, number>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(counts)) {
    if (v > 0) out[k] = v;
  }
  return out;
}
