// Central terminal theme for frugl's human-readable output.
//
// All color goes through picocolors, which auto-disables when stdout is not a
// TTY or NO_COLOR is set — so piped/CI output and --json stay plain text.
// Never style JSON output: callers must emit machine-readable JSON raw.

import pc from "picocolors";

// picocolors keys off process.stdout for its global enabled flag. err/warn
// always go to stderr, so when stdout is piped (e.g. --json | jq) colors
// would be lost on stderr even though it's still a terminal. Bypass pc and
// check stderr directly for these two.
const stderrHasColor = (): boolean =>
  process.env.NO_COLOR === undefined &&
  (process.env.FORCE_COLOR !== undefined || process.stderr.isTTY === true);
const ANSI_RED = (s: string): string => `\x1b[31m${s}\x1b[39m`;
const ANSI_YELLOW = (s: string): string => `\x1b[33m${s}\x1b[39m`;

// Two-color Frugl system:
//   frog  green = the brand. commands, flags, URLs, savings, success.
//   amber yellow = the meter. waste, spend bars, gauges, caution.
//   red          = honest failure only.
export const color = {
  frog: (s: string): string => pc.green(s),
  frogBold: (s: string): string => pc.bold(pc.green(s)),
  ok: (s: string): string => pc.green(s),
  warn: (s: string): string => (stderrHasColor() ? ANSI_YELLOW(s) : s),
  err: (s: string): string => (stderrHasColor() ? ANSI_RED(s) : s),
  dim: (s: string): string => pc.dim(s),
  mute: (s: string): string => pc.gray(s),
  bold: (s: string): string => pc.bold(s),
  info: (s: string): string => pc.blue(s),
  accent: (s: string): string => pc.magenta(s),
  underline: (s: string): string => pc.underline(s),
} as const;

// Status glyphs, pre-colored for their conventional meaning.
export const symbol = {
  tick: pc.green("✓"),
  cross: pc.red("✗"),
  pointer: pc.bold(pc.green("❯")),
  radioOn: pc.green("◉"),
  radioOff: pc.dim("◯"),
  warn: pc.yellow("⚠"),
  resume: pc.yellow("↻"),
  activeDot: pc.green("●"),
  bullet: pc.dim("·"),
} as const;

// A horizontal bar of `width` cells, `filled` of them solid, rest dim.
// tone "amber" (default) = the meter/waste gauge; tone "frog" = savings/positive bars.
export function bar(filled: number, width = 20, tone: "amber" | "frog" = "amber"): string {
  const f = Math.max(0, Math.min(width, Math.round(filled)));
  const solid = tone === "frog" ? pc.green("█".repeat(f)) : pc.yellow("█".repeat(f));
  return solid + color.dim("░".repeat(width - f));
}

// Human byte size matching the design's "12.4 KB" / "4.8 MB" style.
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb.toFixed(1)} KB`;
  const mb = kb / 1024;
  if (mb < 1024) return `${mb.toFixed(1)} MB`;
  return `${(mb / 1024).toFixed(1)} GB`;
}

// "✓ <label>" / "✗ <label>" status lines.
export function okLine(label: string): string {
  return `${symbol.tick} ${label}`;
}
export function errLine(label: string): string {
  return `${symbol.cross} ${label}`;
}
