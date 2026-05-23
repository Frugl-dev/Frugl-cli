import { claudeCodeSource } from "./claude-code/index.js";
import type { Source } from "./types.js";

export const SOURCES: readonly Source[] = [claudeCodeSource];

export function getSourceByKind(kind: string): Source | undefined {
  return SOURCES.find((s) => s.kind === kind);
}
