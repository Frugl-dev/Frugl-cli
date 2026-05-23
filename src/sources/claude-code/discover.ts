import { stat } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { glob } from "tinyglobby";
import type { SessionRef } from "../types.js";

export const CLAUDE_SOURCE_KIND = "claude-code";

export async function discoverClaudeSessions(opts?: { homeDir?: string }): Promise<SessionRef[]> {
  const home = opts?.homeDir ?? homedir();
  const root = path.join(home, ".claude", "projects");
  const files = await glob(["**/*.jsonl"], {
    cwd: root,
    absolute: true,
    dot: false,
  });
  const refs: SessionRef[] = [];
  for (const file of files) {
    const stats = await stat(file).catch(() => null);
    if (!stats || !stats.isFile()) continue;
    refs.push({
      sourceKind: CLAUDE_SOURCE_KIND,
      absolutePath: path.resolve(file),
      byteSizeOnDisk: stats.size,
      mtimeMs: stats.mtimeMs,
    });
  }
  return refs;
}
