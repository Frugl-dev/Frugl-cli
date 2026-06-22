import type { AnonymizationResult } from "../anonymize/index.js";
import type { WireSkillScopesPayload } from "../cloud/schemas.js";
import type { UploadCloudPort } from "../upload/cloud-port.js";
import { uploadSnapshot, type SnapshotUploadResult } from "../upload/snapshot.js";

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
  // Skill-scope map parsed from the /context Source column (fail-open); omitted
  // when the breakdown has no scope-bearing skills.
  skillScopes?: WireSkillScopesPayload;
}

export type ContextUploadResult = SnapshotUploadResult;

// Upload a single context snapshot: the anonymized /context TEXT is PUT verbatim
// (UTF-8, not JSON-wrapped) under a context_snapshot manifest. The declared MCP
// inventory (names-only, fail-open) rides the manifest. Delegates the handshake
// to the shared snapshot core (src/upload/snapshot.ts).
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
    // The PUT body is the anonymized stdout TEXT bytes (UTF-8), not JSON-wrapped.
    body: Buffer.from(String(input.anonymization.payload), "utf8"),
    byteSize: input.anonymization.byteSize,
    contentHash: input.anonymization.contentHashHex,
    redactionSummary: input.anonymization.redactionsByCategory,
    ...(input.mcpServers?.length ? { mcpServers: input.mcpServers } : {}),
    ...(input.skillScopes ? { skillScopes: input.skillScopes } : {}),
  });
}
