import { randomUUID } from "node:crypto";
import { anonymize } from "../anonymize/index.js";
import { captureContext } from "../context/capture.js";
import { CONTEXT_FORMAT_VERSION } from "../context/upload.js";
import { captureDeclaredMcpServers } from "../capture/claude/mcp-inventory.js";
import { HttpCloudAdapter } from "../upload/cloud-http-adapter.js";
import type { CloudClient } from "../cloud/client.js";
import type { AuthSession } from "../auth/session.js";
import { uploadSnapshot } from "./upload.js";
import { buildMcpSnapshotDocument, captureMcpSnapshot, MCP_FORMAT_VERSION } from "./mcp-capture.js";

// The kinds of snapshot `frugl snapshot` can capture. Drives `--all` and the
// per-kind subcommands off one vocabulary.
export type SnapshotKind = "context" | "mcp";

// A successful snapshot upload, shaped for both the JSON and text receipts.
export interface SnapshotResult {
  kind: SnapshotKind;
  tool: string;
  capturedAt: string;
  manifestId: string;
  sessionId: string;
  dashboardUrl: string;
  byteSize: number;
  redactionPolicyVersion: string;
}

export interface SnapshotRunDeps {
  client: CloudClient;
  session: AuthSession;
}

const TOOL = "claude-code";

// Local-only random salt. The pseudonym HMAC key must never equal a value that
// ships in the manifest (capturedAt does), or pseudonyms become
// dictionary-reversible by anyone holding the payload.
function anonymizeOpts(session: AuthSession): {
  uploadId: string;
  ownerEmail: string;
  homeDir?: string;
} {
  const homeDir = process.env["FRUGL_HOME_DIR"];
  return {
    uploadId: randomUUID(),
    ownerEmail: session.email,
    ...(homeDir !== undefined ? { homeDir } : {}),
  };
}

// Capture → anonymize → upload a single context snapshot. Fail-closed: a missing
// binary / non-zero exit / empty stdout throws before any upload.
export async function runContextSnapshot(deps: SnapshotRunDeps): Promise<SnapshotResult> {
  const capture = captureContext(TOOL);
  const result = anonymize(capture.text, anonymizeOpts(deps.session));
  const cloud = new HttpCloudAdapter(deps.client);
  // The declared MCP inventory (names-only, fail-open) rides the manifest: a
  // failed `claude mcp list` simply omits it, never blocking the snapshot.
  const mcpServers = captureDeclaredMcpServers();
  const upload = await uploadSnapshot({
    cloud,
    cliVersion: deps.client.cliVersion,
    sourceKind: TOOL,
    policyVersion: result.policyVersion,
    capturedAt: capture.capturedAt,
    artifactKind: "context_snapshot",
    formatVersion: CONTEXT_FORMAT_VERSION,
    body: Buffer.from(String(result.payload), "utf8"),
    expectedBytes: result.byteSize,
    redactionsByCategory: result.redactionsByCategory,
    ...(mcpServers ? { mcpServers } : {}),
  });
  return {
    kind: "context",
    tool: TOOL,
    capturedAt: capture.capturedAt,
    manifestId: upload.manifestId,
    sessionId: upload.sessionId,
    dashboardUrl: upload.dashboardUrl,
    byteSize: result.byteSize,
    redactionPolicyVersion: result.policyVersion,
  };
}

// Capture → anonymize → upload a single MCP-inventory snapshot. Fail-closed: a
// missing/failing `claude` binary or a zero-server inventory throws before any
// upload. The serialized inventory is run through the same anonymizer as the
// context snapshot, so secrets embedded in server targets are scrubbed while
// server names survive as config identifiers.
export async function runMcpSnapshot(deps: SnapshotRunDeps): Promise<SnapshotResult> {
  const capture = captureMcpSnapshot();
  const result = anonymize(buildMcpSnapshotDocument(capture), anonymizeOpts(deps.session));
  const cloud = new HttpCloudAdapter(deps.client);
  const upload = await uploadSnapshot({
    cloud,
    cliVersion: deps.client.cliVersion,
    sourceKind: TOOL,
    policyVersion: result.policyVersion,
    capturedAt: capture.capturedAt,
    artifactKind: "mcp_snapshot",
    formatVersion: MCP_FORMAT_VERSION,
    body: Buffer.from(JSON.stringify(result.payload), "utf8"),
    expectedBytes: result.byteSize,
    redactionsByCategory: result.redactionsByCategory,
  });
  return {
    kind: "mcp",
    tool: TOOL,
    capturedAt: capture.capturedAt,
    manifestId: upload.manifestId,
    sessionId: upload.sessionId,
    dashboardUrl: upload.dashboardUrl,
    byteSize: result.byteSize,
    redactionPolicyVersion: result.policyVersion,
  };
}

export const SNAPSHOT_RUNNERS: Record<
  SnapshotKind,
  (deps: SnapshotRunDeps) => Promise<SnapshotResult>
> = {
  context: runContextSnapshot,
  mcp: runMcpSnapshot,
};

export const SNAPSHOT_LABEL: Record<SnapshotKind, string> = {
  context: "Context snapshot",
  mcp: "MCP snapshot",
};
