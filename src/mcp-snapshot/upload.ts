import type { UploadCloudPort } from "../upload/cloud-port.js";
import { uploadSnapshot, type SnapshotUploadResult } from "../upload/snapshot.js";
import type { McpPayload } from "./payload.js";

// The format_version stamped on an mcp snapshot manifest entry — the cloud routes
// the MCP inventory parse path on it.
export const MCP_FORMAT_VERSION = "mcp/v1";

export interface McpUploadInput {
  cloud: UploadCloudPort;
  cliVersion: string;
  sourceKind: string;
  capturedAt: string;
  payload: McpPayload;
}

export type McpUploadResult = SnapshotUploadResult;

// Upload a single MCP snapshot: the anonymized inventory JSON is PUT under an
// mcp_snapshot manifest. Delegates the handshake to the shared snapshot core
// (src/upload/snapshot.ts) — the gate (no_change / cap_reached) applies just as
// it does to context snapshots.
export async function uploadMcpSnapshot(input: McpUploadInput): Promise<McpUploadResult> {
  return uploadSnapshot({
    cloud: input.cloud,
    cliVersion: input.cliVersion,
    sourceKind: input.sourceKind,
    policyVersion: input.payload.policyVersion,
    capturedAt: input.capturedAt,
    artifactKind: "mcp_snapshot",
    formatVersion: MCP_FORMAT_VERSION,
    body: input.payload.body,
    byteSize: input.payload.byteSize,
    contentHash: input.payload.contentHash,
    redactionSummary: input.payload.redactionSummary,
  });
}
