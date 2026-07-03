import type { McpStatus } from "../types.js";
import { defaultIO, type CaptureIO } from "./io.js";
import { parseMcpList } from "./mcp.js";

// The names-only declared-MCP-server inventory that rides the upload manifest
// (the smallest slice of spec 026): server NAME + health status, nothing else.
// Transport and target are deliberately dropped here — a target can embed
// secrets (`npx … --key=…`), and by never reading it we are names-only by
// construction rather than by scrubbing (fail-closed, Principle VI).
//
// Capture is fail-open: this is additive metadata on a session upload, so a
// missing `claude` binary, a non-zero exit, or an unparseable line yields
// `undefined` (field omitted from the manifest) — never a blocked upload.

export interface DeclaredMcpServer {
  name: string;
  status: McpStatus;
}

// Server-side bound (manifest contract); keep in lockstep with the cloud's
// MCP_MAX_SERVERS so an oversized inventory degrades to "omitted" client-side
// instead of a 400 on the whole manifest.
const MAX_SERVERS = 100;

// Per-source inventory commands. Codex has a --json flag (verified on-machine
// 2026-07-02: emits a JSON array); Gemini's `mcp list` is text — its populated
// line shape is UNVERIFIED, so it routes through the retain-and-flag text
// parser and degrades to "omitted" if the format differs (fail-open, never
// wrong data). Sources not listed here carry no inventory.
const INVENTORY_COMMANDS: Record<
  string,
  {
    binary: string;
    args: string[];
    parse: (stdout: string) => { name: string; status: McpStatus }[];
  }
> = {
  "claude-code": {
    binary: "claude",
    args: ["mcp", "list"],
    parse: (stdout) => parseMcpList(stdout).items,
  },
  codex: {
    binary: "codex",
    args: ["mcp", "list", "--json"],
    parse: parseJsonMcpList,
  },
  gemini: {
    binary: "gemini",
    args: ["mcp", "list"],
    parse: (stdout) => parseMcpList(stdout).items,
  },
};

// Tolerant parse of a JSON `mcp list --json` payload: an array of objects with
// a `name` (health is not part of codex's JSON shape today → "unknown").
// Anything unexpected yields [] — capture then omits the field.
function parseJsonMcpList(stdout: string): { name: string; status: McpStatus }[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const items: { name: string; status: McpStatus }[] = [];
  for (const entry of parsed) {
    if (!entry || typeof entry !== "object") continue;
    const name = (entry as Record<string, unknown>).name;
    if (typeof name === "string" && name.length > 0) items.push({ name, status: "unknown" });
  }
  return items;
}

export function captureDeclaredMcpServers(
  io: CaptureIO = defaultIO,
  sourceKind = "claude-code",
): DeclaredMcpServer[] | undefined {
  const command = INVENTORY_COMMANDS[sourceKind];
  if (!command) return undefined;
  let run;
  try {
    run = io.run(command.binary, command.args);
  } catch {
    return undefined;
  }
  if (run.status !== 0) return undefined;

  const items = command.parse(run.stdout);
  if (items.length === 0) return undefined;

  const seen = new Set<string>();
  const servers: DeclaredMcpServer[] = [];
  for (const s of items) {
    if (seen.has(s.name)) continue;
    seen.add(s.name);
    servers.push({ name: s.name, status: s.status });
  }
  if (servers.length > MAX_SERVERS) return undefined;
  return servers;
}
