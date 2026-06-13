import { Flags } from "@oclif/core";
import { setPlainOutput } from "./theme.js";

// The user-facing output formats, selected with `--format`:
//   default  → rich, colored, decorated human output (interactive terminals).
//   json     → machine-readable JSON / NDJSON (one object per result).
//   minimal  → plain, decoration-free text for agents and CI: no color, no
//              mascot, no progress animation. Auto-selected when CI is detected.
export type OutputMode = "default" | "json" | "minimal";

export const OUTPUT_FORMATS = ["default", "json", "minimal"] as const;

export interface OutputModeFlags {
  format?: string | undefined;
}

// The shared `--format` flag. No default value on purpose: an unset flag means
// "auto", so `resolveOutputMode` can pick `minimal` under CI and `default`
// otherwise. oclif validates the value against `options`, so an invalid format
// fails before resolution.
export const FORMAT_FLAG = Flags.string({
  description:
    "Output format: default (rich human output), json (machine-readable), or minimal (plain text for agents/CI). Defaults to minimal when CI is detected, otherwise default.",
  options: [...OUTPUT_FORMATS],
  helpValue: "default|json|minimal",
});

// Standard CI detection: virtually every CI provider exports `CI`; a handful of
// the common ones are matched explicitly for the rare cases that don't.
export function isCi(env: NodeJS.ProcessEnv = process.env): boolean {
  const ci = env.CI;
  if (ci !== undefined && ci !== "" && ci !== "0" && ci !== "false") return true;
  return (
    env.GITHUB_ACTIONS !== undefined ||
    env.GITLAB_CI !== undefined ||
    env.CIRCLECI !== undefined ||
    env.BUILDKITE !== undefined ||
    env.TF_BUILD !== undefined // Azure Pipelines
  );
}

function pickFormat(raw: string | undefined): OutputMode {
  if (raw === "default" || raw === "json" || raw === "minimal") return raw;
  // No explicit --format: agents/CI get the porcelain `minimal`; an interactive
  // run gets the rich `default`.
  return isCi() ? "minimal" : "default";
}

// Resolve the active output format AND apply its global side effect: `minimal`
// forces decoration-free, color-free output everywhere (theme.setPlainOutput).
// Centralized here so every command — whether it resolves directly or through
// buildCommandContext — gets identical behavior from one call.
export function resolveOutputMode(flags: OutputModeFlags): OutputMode {
  const mode = pickFormat(flags.format);
  setPlainOutput(mode === "minimal");
  return mode;
}

export function resolveDebug(): boolean {
  const v = process.env.FRUGL_DEBUG;
  return v === "1" || v === "true";
}
