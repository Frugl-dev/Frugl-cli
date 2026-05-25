import { stat } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { glob } from "tinyglobby";
import type { SessionRef } from "../types.js";

export const CURSOR_SOURCE_KIND = "cursor";
export const CURSOR_FORMAT_VERSION = "cursor-jsonl-2026-05";

export async function discoverCursorSessions(opts?: { homeDir?: string }): Promise<SessionRef[]> {
  const home = opts?.homeDir ?? homedir();
  const root = path.join(home, ".cursor", "projects");
  const files = await glob(["**/agent-transcripts/**/*.jsonl"], {
    cwd: root,
    absolute: true,
    dot: false,
  }).catch(() => []);
  const refs: SessionRef[] = [];
  for (const file of files) {
    const stats = await stat(file).catch(() => null);
    if (!stats || !stats.isFile()) continue;
    refs.push({
      sourceKind: CURSOR_SOURCE_KIND,
      absolutePath: path.resolve(file),
      byteSizeOnDisk: stats.size,
      mtimeMs: stats.mtimeMs,
    });
  }
  return refs;
}
