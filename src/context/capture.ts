import { FruglError } from "../lib/errors.js";
import { EXIT } from "../lib/exit-codes.js";
import { nowIso } from "../lib/time.js";
import { captureClaudeCodeContext, type Spawner } from "./tools/claude-code.js";

// The tools we know how to capture a /context breakdown from. Today only Claude
// Code is wired; codex/gemini/cursor are reserved so the dispatch table is the
// single place a new runner is added. The dashed vocabulary matches the upload
// source_kind ("claude-code").
export type ContextTool = "claude-code";

// One captured snapshot: the tool's raw /context stdout TEXT plus the moment of
// capture. `capturedAt` is stamped here, at capture time, so two runs always
// carry distinct timestamps (US4) — there is no overwrite/dedupe.
export interface ContextCapture {
  tool: ContextTool;
  text: string;
  capturedAt: string;
}

export interface CaptureOptions {
  // Injectable clock + spawner for tests; production uses the real wall clock
  // and `node:child_process`.
  now?: () => string;
  spawner?: Spawner;
}

// A per-tool runner: returns the tool's /context stdout verbatim, or throws a
// FruglError (fail-closed) on any uncertainty.
type Runner = (spawner?: Spawner) => string;

const RUNNERS: Record<ContextTool, Runner> = {
  "claude-code": (spawner) => captureClaudeCodeContext(spawner),
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

  const text = RUNNERS[tool](opts.spawner);

  // Defense in depth: the runner already rejects empty stdout, but re-assert
  // here so the dispatch contract holds for any future runner too.
  if (text.trim().length === 0) {
    throw new FruglError(`Context capture for '${tool}' produced no output.`, EXIT.GENERIC_FAILURE);
  }

  const now = opts.now ?? nowIso;
  return { tool, text, capturedAt: now() };
}
