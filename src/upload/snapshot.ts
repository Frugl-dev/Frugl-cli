import { randomUUID } from "node:crypto";
import { withRetry } from "../lib/retry.js";
import type { ArtifactKind, WireDeclaredMcpServer } from "../cloud/schemas.js";
import type { UploadCloudPort } from "./cloud-port.js";

// The shared manifest -> presign -> PUT -> complete handshake for a single
// timestamped snapshot artifact (context or mcp). Unlike the session pipeline
// there is no resume/ledger: each run mints a fresh uuid v4 + uses the capture
// timestamp, so re-invoking after a failure simply starts a brand-new manifest
// (no partial state to clean up — the fail-closed re-invocation guarantee).
//
// The manifest carries a content_hash (spec 052) so the server can skip an
// unchanged capture before any bytes are sent; it may also refuse the upload
// when the user is over their weekly cap. Both short-circuit before presign.
export interface SnapshotUploadInput {
  cloud: UploadCloudPort;
  cliVersion: string;
  sourceKind: string;
  policyVersion: string;
  capturedAt: string;
  artifactKind: ArtifactKind;
  // The per-artifact wire format the cloud routes the parse path on
  // ("context/v1", "mcp/v1").
  formatVersion: string;
  // The exact anonymized bytes to PUT.
  body: Uint8Array;
  // expected_bytes on the manifest entry. Kept distinct from body.byteLength so
  // each caller controls it: a text snapshot reports its serialized size, a JSON
  // snapshot reports the body length.
  byteSize: number;
  // The no-change fingerprint (spec 052): stable across runs, independent of the
  // per-run uploadId and the capture timestamp.
  contentHash: string;
  redactionSummary: Record<string, number>;
  // Declared MCP server inventory (names-only, fail-open) recorded on the upload
  // row server-side; rides the context manifest, omitted otherwise.
  mcpServers?: WireDeclaredMcpServer[];
}

export type SnapshotUploadResult =
  // The snapshot was uploaded and parsed.
  | { status: "uploaded"; manifestId: string; sessionId: string; dashboardUrl: string }
  // The capture was identical to the user's latest snapshot — the server skipped
  // the upload (spec 052) and nothing left the machine.
  | { status: "no_change" }
  // The user is at their weekly snapshot cap — the server refused it; nothing
  // was uploaded.
  | { status: "cap_reached"; cap: number; used: number; windowResetsAt: string };

export async function uploadSnapshot(input: SnapshotUploadInput): Promise<SnapshotUploadResult> {
  const sessionId = randomUUID();

  const manifest = await input.cloud.createManifest({
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
        expected_bytes: input.byteSize,
        captured_at: input.capturedAt,
        content_hash: input.contentHash,
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
    await input.cloud.putSessionBody(presigned.url, input.body, { ...presigned.headers });
  });

  const complete = await input.cloud.completeManifest(
    uploadId,
    filterPositive(input.redactionSummary),
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
