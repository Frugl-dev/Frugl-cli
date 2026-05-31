import type { CapturedMcpServer, McpStatus, McpTransport, SourceResult } from "../types.js";

// Parse `claude mcp list` stdout. The command emits one line per configured MCP
// server plus a leading health-check banner; it has NO --json flag, so this is a
// text parser (research Decision 1). Verified shape:
//
//   plugin:github:github: https://api.githubcopilot.com/mcp/ (HTTP) - ✗ Failed to connect
//   plugin:playwright:playwright: npx @playwright/mcp@latest - ✓ Connected
//
// A line we cannot parse marks the source `unparsed` (retain-and-flag, never a
// silent drop — Constitution Principle VI).

const STATUS_BY_GLYPH: Record<string, McpStatus> = {
  "✓": "connected",
  "✗": "failed",
  "⏸": "pending",
};

const HEALTH_BANNER = "Checking MCP server health";
const TRANSPORT_MARKER = /\s*\((HTTP|SSE)\)\s*$/u;
// name (no spaces, may contain colons) ": " target " - " <glyph> <status words>
const LINE = /^(\S+):\s+(.+?)\s+-\s+([✓✗⏸])\s+.*$/u;

function parseLine(line: string): CapturedMcpServer | null {
  const m = LINE.exec(line);
  if (!m) return null;
  const name = m[1];
  const rawTarget = m[2];
  const glyph = m[3];
  if (name === undefined || rawTarget === undefined || glyph === undefined) return null;
  const status = STATUS_BY_GLYPH[glyph] ?? "unknown";
  let transport: McpTransport = "stdio";
  let target = rawTarget;
  if (TRANSPORT_MARKER.test(rawTarget)) {
    transport = "http";
    target = rawTarget.replace(TRANSPORT_MARKER, "");
  }
  return { name, transport, target, status };
}

export function parseMcpList(stdout: string): SourceResult<CapturedMcpServer> {
  const items: CapturedMcpServer[] = [];
  let parseStatus: SourceResult<CapturedMcpServer>["parseStatus"] = "parsed";
  for (const raw of stdout.split("\n")) {
    const line = raw.trim();
    if (line === "") continue;
    if (line.startsWith(HEALTH_BANNER)) continue;
    const server = parseLine(line);
    if (!server) {
      parseStatus = "unparsed";
      continue;
    }
    items.push(server);
  }
  return { items, parseStatus };
}
