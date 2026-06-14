import type { AnonymizationResult } from "../anonymize/index.js";
import type { UploadCloudPort } from "../upload/cloud-port.js";
import { uploadSnapshot } from "../snapshot/upload.js";

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

export interface ContextUploadResult {
  manifestId: string;
  sessionId: string;
  dashboardUrl: string;
}

// Run the snapshot handshake for a single context snapshot. The PUT body is the
// anonymized stdout TEXT bytes (UTF-8), not JSON-wrapped. See uploadSnapshot for
// the shared manifest -> presign -> PUT -> complete flow and its fail-closed
// re-invocation guarantee.
export async function uploadContextSnapshot(
  input: ContextUploadInput,
): Promise<ContextUploadResult> {
  return uploadSnapshot({
    cloud: input.cloud,
    cliVersion: input.cliVersion,
    sourceKind: input.sourceKind,
    policyVersion: input.policyVersion,
    capturedAt: input.capturedAt,
    artifactKind: "context_snapshot",
    formatVersion: CONTEXT_FORMAT_VERSION,
    body: Buffer.from(String(input.anonymization.payload), "utf8"),
    expectedBytes: input.anonymization.byteSize,
    redactionsByCategory: input.anonymization.redactionsByCategory,
    ...(input.mcpServers?.length ? { mcpServers: input.mcpServers } : {}),
  });
}
