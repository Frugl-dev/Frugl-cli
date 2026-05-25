import { stat } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { glob } from "tinyglobby";
import type { SessionRef } from "../types.js";

export const GEMINI_SOURCE_KIND = "gemini";
export const GEMINI_FORMAT_VERSION = "gemini-json-2026-05";

export async function discoverGeminiSessions(opts?: { homeDir?: string }): Promise<SessionRef[]> {
  const home = opts?.homeDir ?? homedir();
  const root = path.join(home, ".gemini", "tmp");
  const files = await glob(["*/logs.json"], {
    cwd: root,
    absolute: true,
    dot: false,
  }).catch(() => []);
  const refs: SessionRef[] = [];
  for (const file of files) {
    const stats = await stat(file).catch(() => null);
    if (!stats || !stats.isFile()) continue;
    refs.push({
      sourceKind: GEMINI_SOURCE_KIND,
      absolutePath: path.resolve(file),
      byteSizeOnDisk: stats.size,
      mtimeMs: stats.mtimeMs,
    });
  }
  return refs;
}
