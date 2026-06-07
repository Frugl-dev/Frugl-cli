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

export function captureDeclaredMcpServers(
  io: CaptureIO = defaultIO,
): DeclaredMcpServer[] | undefined {
  let run;
  try {
    run = io.run("claude", ["mcp", "list"]);
  } catch {
    return undefined;
  }
  if (run.status !== 0) return undefined;

  const parsed = parseMcpList(run.stdout);
  if (parsed.items.length === 0) return undefined;

  const seen = new Set<string>();
  const servers: DeclaredMcpServer[] = [];
  for (const s of parsed.items) {
    if (seen.has(s.name)) continue;
    seen.add(s.name);
    servers.push({ name: s.name, status: s.status });
  }
  if (servers.length > MAX_SERVERS) return undefined;
  return servers;
}
