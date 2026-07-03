import { FruglError } from "../lib/errors.js";
import { EXIT } from "../lib/exit-codes.js";
import { captureClaudeCodeContext, type Spawner } from "./tools/claude-code.js";
import {
  captureCodexArtifacts,
  captureCursorArtifacts,
  captureGeminiArtifacts,
} from "./tools/artifacts.js";

// The tools we know how to capture a context snapshot from. Claude Code emits a
// provider-reported window breakdown (`claude -p "/context"`); codex/gemini/
// cursor have NO headless context command, so their runners synthesize an
// artifact-loadout payload (memory/rules files + declared MCP, sizes only —
// see ./tools/artifacts.ts). The dashed vocabulary matches the upload
// source_kind ("claude-code").
export type ContextTool = "claude-code" | "codex" | "gemini" | "cursor";

// One captured snapshot: the tool's raw capture TEXT (stdout for Claude, a
// frugl.context-artifacts JSON document for the others) plus the moment of
// capture. `capturedAt` is stamped here, at capture time, so two runs always
// carry distinct timestamps (US4) — there is no overwrite/dedupe.
export interface ContextCapture {
  tool: ContextTool;
  text: string;
  capturedAt: string;
}

export interface CaptureOptions {
  // Injectable clock + spawner (Claude) / filesystem roots (artifact runners)
  // for tests; production uses the real wall clock, subprocess, cwd, and home.
  now?: () => string;
  spawner?: Spawner;
  cwd?: string;
  homeDir?: string;
}

// A per-tool runner: returns the tool's capture text verbatim, or throws a
// FruglError (fail-closed) on any uncertainty.
type Runner = (opts: CaptureOptions) => string;

const RUNNERS: Record<ContextTool, Runner> = {
  "claude-code": (opts) => captureClaudeCodeContext(opts.spawner),
  codex: (opts) => captureCodexArtifacts(opts),
  gemini: (opts) => captureGeminiArtifacts(opts),
  cursor: (opts) => captureCursorArtifacts(opts),
};

const SUPPORTED_TOOLS = Object.keys(RUNNERS) as ContextTool[];

function isSupported(tool: string): tool is ContextTool {
  return (SUPPORTED_TOOLS as string[]).includes(tool);
}

// Dispatch to the configured tool's runner, capture its /context stdout, and
// stamp the capture timestamp. Fail-closed throughout: an unsupported tool, a
// missing binary, a non-zero subprocess exit, or empty stdout each throw a
// FruglError so the command exits non-zero with NO upload. A failed run leaves
// no state behind — the next invocation starts clean (US4).
export function captureContext(tool: string, opts: CaptureOptions = {}): ContextCapture {
  if (!isSupported(tool)) {
    throw new FruglError(
      `Context capture is not supported for tool '${tool}'. Supported tools: ${SUPPORTED_TOOLS.join(", ")}.`,
      EXIT.GENERIC_FAILURE,
    );
  }

  const text = RUNNERS[tool](opts);

  // Defense in depth: the runner already rejects empty stdout, but re-assert
  // here so the dispatch contract holds for any future runner too.
  if (text.trim().length === 0) {
    throw new FruglError(`Context capture for '${tool}' produced no output.`, EXIT.GENERIC_FAILURE);
  }

  const now = opts.now ?? (() => new Date().toISOString());
  return { tool, text, capturedAt: now() };
}
