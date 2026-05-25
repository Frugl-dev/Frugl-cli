import { claudeCodeSource } from "./claude-code/index.js";
import { cursorSource } from "./cursor/index.js";
import { codexSource } from "./codex/index.js";
import { geminiSource } from "./gemini/index.js";
import type { Source } from "./types.js";

export const SOURCES: readonly Source[] = [
  claudeCodeSource,
  cursorSource,
  codexSource,
  geminiSource,
];

export function getSourceByKind(kind: string): Source | undefined {
  return SOURCES.find((s) => s.kind === kind);
}
