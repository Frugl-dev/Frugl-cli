import { anonymize, type AnonymizeOptions } from "../anonymize/index.js";
import type { McpInventory } from "./capture.js";

// The anonymized, upload-ready MCP snapshot: the JSON body to PUT plus the
// metadata the manifest needs.
export interface McpPayload {
  body: Buffer;
  byteSize: number;
  // The no-change fingerprint — stable across runs with the same servers,
  // independent of the per-run uploadId and the capture timestamp.
  contentHash: string;
  redactionSummary: Record<string, number>;
  policyVersion: string;
}

// Anonymize an MCP inventory into its upload body. The whole document is walked
// so every target string is scrubbed of secrets in place (`anonymize` redacts
// string values structurally — names/transport/status enums pass through, the
// `target` of `npx … --key=…` or a URL with an embedded token does not).
//
// `capturedAt` is split off BEFORE hashing: it changes every run, so a content
// hash that included it could never match the server's last snapshot and the
// no-change gate (spec 052) would never fire. We hash the timestamp-free
// inventory, then graft `capturedAt` back onto the scrubbed payload so the
// uploaded document still carries when it was taken.
export function buildMcpPayload(inventory: McpInventory, opts: AnonymizeOptions): McpPayload {
  const { capturedAt, ...stable } = inventory;
  const result = anonymize(stable, opts);
  const document = { ...(result.payload as Record<string, unknown>), capturedAt };
  const body = Buffer.from(JSON.stringify(document), "utf8");
  return {
    body,
    byteSize: body.byteLength,
    contentHash: result.contentHashHex,
    redactionSummary: result.redactionsByCategory,
    policyVersion: result.policyVersion,
  };
}
