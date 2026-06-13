import type { OutputMode } from "../lib/output-mode.js";

export interface InteractiveOptions {
  // The resolved output format. Anything other than `default` (i.e. json or
  // minimal) is treated as non-interactive.
  mode?: OutputMode | undefined;
  yes?: boolean | undefined;
  // Injectable for tests; defaults to the real stdin TTY status.
  isTTY?: boolean | undefined;
}

// Interactive only in a real terminal session that hasn't opted into a
// non-interactive format. A `json`/`minimal` format, `--yes`, or a non-TTY
// stdin (CI, pipes) all mean: prompt nothing, auto-select everything supported
// (FR-018).
export function isInteractive(opts: InteractiveOptions): boolean {
  if (opts.mode !== undefined && opts.mode !== "default") return false;
  if (opts.yes) return false;
  return Boolean(opts.isTTY ?? process.stdin.isTTY);
}
