import { FruglError } from "../lib/errors.js";
import { EXIT } from "../lib/exit-codes.js";
import { defaultIO, type CaptureIO } from "../capture/claude/io.js";
import { parseMcpList } from "../capture/claude/mcp.js";
import type { CapturedMcpServer, SourceParseStatus } from "../capture/types.js";

// The format_version stamped on an mcp snapshot manifest entry. Distinct from the
// per-source session and context format versions so the cloud can route the parse
// path.
export const MCP_FORMAT_VERSION = "mcp/v1";

// Today only Claude Code is wired; the dashed vocabulary matches the upload
// source_kind ("claude-code").
const TOOL = "claude-code";

// One captured MCP-server inventory: the full per-server shape (name, transport,
// scrubbed-later target, status) plus the moment of capture. `capturedAt` is
// stamped here so two runs always carry distinct timestamps — there is no
// overwrite/dedupe, mirroring the context snapshot.
export interface McpSnapshotCapture {
  tool: string;
  capturedAt: string;
  // "unparsed" when a line drifted from the known `claude mcp list` format: the
  // servers we could read are still uploaded, the flag rides along (Principle VI).
  parseStatus: SourceParseStatus;
  servers: CapturedMcpServer[];
}

export interface McpCaptureOptions {
  io?: CaptureIO;
  now?: () => string;
}

// Capture the configured MCP-server inventory by running `claude mcp list`.
// Fail-closed, mirroring the context snapshot: a missing/failing `claude` binary
// or a zero-server inventory each throw a FruglError so the command exits
// non-zero with NO upload. A failed run leaves no state behind — the next
// invocation starts clean.
export function captureMcpSnapshot(opts: McpCaptureOptions = {}): McpSnapshotCapture {
  const io = opts.io ?? defaultIO;

  const run = io.run("claude", ["mcp", "list"]);
  if (run.status !== 0) {
    throw new FruglError(
      "Could not run 'claude mcp list'. Install Claude Code (https://docs.claude.com/claude-code) and ensure `claude` is runnable, then re-run `frugl snapshot mcp`.",
      EXIT.GENERIC_FAILURE,
    );
  }

  const parsed = parseMcpList(run.stdout);
  if (parsed.items.length === 0) {
    throw new FruglError(
      "No MCP servers are configured for Claude Code — nothing to snapshot.",
      EXIT.GENERIC_FAILURE,
    );
  }

  const now = opts.now ?? (() => new Date().toISOString());
  return {
    tool: TOOL,
    capturedAt: now(),
    parseStatus: parsed.parseStatus,
    servers: parsed.items,
  };
}

// The pre-anonymization JSON document uploaded as the mcp_snapshot body. Server
// `target` values can embed secrets (`npx … --key=…`); the anonymizer scrubs them
// before this becomes the PUT body. Server names are preserved as config
// identifiers (same treatment as the context snapshot).
export function buildMcpSnapshotDocument(capture: McpSnapshotCapture): {
  schemaVersion: 1;
  sourceTool: string;
  capturedAt: string;
  parseStatus: SourceParseStatus;
  mcpServers: CapturedMcpServer[];
} {
  return {
    schemaVersion: 1,
    sourceTool: capture.tool,
    capturedAt: capture.capturedAt,
    parseStatus: capture.parseStatus,
    mcpServers: capture.servers,
  };
}
