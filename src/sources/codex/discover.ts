import { stat } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { glob } from "tinyglobby";
import type { SessionRef } from "../types.js";

export const CODEX_SOURCE_KIND = "codex";
export const CODEX_FORMAT_VERSION = "codex-jsonl-2026-05";

export async function discoverCodexSessions(opts?: { homeDir?: string }): Promise<SessionRef[]> {
  const home = opts?.homeDir ?? homedir();
  const root = path.join(home, ".codex", "sessions");
  const files = await glob(["**/*.jsonl"], {
    cwd: root,
    absolute: true,
    dot: false,
  }).catch(() => []);
  const refs: SessionRef[] = [];
  for (const file of files) {
    const stats = await stat(file).catch(() => null);
    if (!stats || !stats.isFile()) continue;
    refs.push({
      sourceKind: CODEX_SOURCE_KIND,
      absolutePath: path.resolve(file),
      byteSizeOnDisk: stats.size,
      mtimeMs: stats.mtimeMs,
    });
  }
  return refs;
}
