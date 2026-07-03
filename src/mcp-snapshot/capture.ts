import { FruglError } from "../lib/errors.js";
import { EXIT } from "../lib/exit-codes.js";
import { nowIso } from "../lib/time.js";
import { defaultIO, type CaptureIO } from "../capture/claude/io.js";
import { parseMcpList } from "../capture/claude/mcp.js";
import type { CapturedMcpServer, SourceParseStatus } from "../capture/types.js";

// A standalone MCP-server snapshot (spec 026): the full declared inventory from
// `claude mcp list` — name, transport, target, health — captured at a moment in
// time, anonymized client-side, and uploaded under its own `mcp_snapshot`
// artifact. Distinct from the names-only inventory that rides a context manifest
// (capture/claude/mcp-inventory.ts): this one keeps transport + target so the
// dashboard can show what each server actually points at (the anonymizer scrubs
// any secret embedded in the target before it leaves the machine).
export const MCP_SCHEMA_VERSION = 1;
// The configured AI tool whose MCP inventory this captures; matches the upload
// source_kind. Today only Claude Code is wired.
export const MCP_SOURCE_TOOL = "claude-code";

// The inventory document, pre-anonymization. `capturedAt` is stamped here so two
// runs always carry distinct timestamps (no overwrite/dedupe).
export interface McpInventory {
  schemaVersion: number;
  sourceTool: string;
  capturedAt: string;
  parseStatus: SourceParseStatus;
  mcpServers: CapturedMcpServer[];
}

export interface McpCaptureOptions {
  // Injectable IO + clock for tests; production uses the real subprocess + clock.
  io?: CaptureIO;
  now?: () => string;
}

// Capture the declared MCP inventory. Fail-closed on a missing/failed `claude`:
// a non-zero `claude mcp list` exit throws a FruglError so the command exits
// non-zero with NO upload. An individual line we cannot parse does NOT fail the
// run — it flips parseStatus to "unparsed" (retain-and-flag, Principle VI) and
// the server keeps the raw document rather than dropping it.
export function captureMcpInventory(opts: McpCaptureOptions = {}): McpInventory {
  const io = opts.io ?? defaultIO;
  const run = io.run("claude", ["mcp", "list"]);
  if (run.status !== 0) {
    throw new FruglError(
      "Could not capture MCP servers: `claude mcp list` failed. Install Claude Code " +
        "(https://docs.claude.com/claude-code), ensure `claude` is on your PATH, then " +
        "re-run `frugl snapshot mcp`.",
      EXIT.GENERIC_FAILURE,
    );
  }

  const parsed = parseMcpList(run.stdout);
  const now = opts.now ?? nowIso;
  return {
    schemaVersion: MCP_SCHEMA_VERSION,
    sourceTool: MCP_SOURCE_TOOL,
    capturedAt: now(),
    parseStatus: parsed.parseStatus,
    mcpServers: parsed.items,
  };
}
