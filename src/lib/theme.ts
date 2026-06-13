// Central terminal theme for frugl's human-readable output.
//
// All color goes through picocolors, which auto-disables when stdout is not a
// TTY or NO_COLOR is set — so piped/CI output and --json stay plain text.
// Never style JSON output: callers must emit machine-readable JSON raw.

import pc from "picocolors";

// Porcelain switch. The `minimal` output format (agents / CI) forces every
// color and symbol to its plain form regardless of TTY — so the output is
// decoration-free even when minimal is requested on a real terminal.
// `resolveOutputMode` flips this once per run before anything renders.
let plain = false;
export function setPlainOutput(value: boolean): void {
  plain = value;
}
export function isPlainOutput(): boolean {
  return plain;
}

// picocolors keys off process.stdout for its global enabled flag. err/warn
// always go to stderr, so when stdout is piped (e.g. --format json | jq) colors
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
// Every helper short-circuits to the raw string under `plain` (minimal format).
export const color = {
  frog: (s: string): string => (plain ? s : pc.green(s)),
  frogBold: (s: string): string => (plain ? s : pc.bold(pc.green(s))),
  ok: (s: string): string => (plain ? s : pc.green(s)),
  warn: (s: string): string => (plain ? s : stderrHasColor() ? ANSI_YELLOW(s) : s),
  err: (s: string): string => (plain ? s : stderrHasColor() ? ANSI_RED(s) : s),
  dim: (s: string): string => (plain ? s : pc.dim(s)),
  mute: (s: string): string => (plain ? s : pc.gray(s)),
  bold: (s: string): string => (plain ? s : pc.bold(s)),
  info: (s: string): string => (plain ? s : pc.blue(s)),
  accent: (s: string): string => (plain ? s : pc.magenta(s)),
  underline: (s: string): string => (plain ? s : pc.underline(s)),
} as const;

// The frugl mascot — one emoticon, surfaced at the personality beats (the hello,
// the upload payoff, the warm empty/error states) and otherwise kept off-screen.
// Centralized so it's a single glyph to change. From the Claude Design "frugl,
// with a pulse" pass.
export const SIGIL = "₍𝄐 ̫𝄐₎";

// Status glyphs, pre-colored for their conventional meaning. Getters so the
// `plain` switch (minimal format) strips color while keeping the glyph.
export const symbol = {
  get tick(): string {
    return plain ? "✓" : pc.green("✓");
  },
  get cross(): string {
    return plain ? "✗" : pc.red("✗");
  },
  get pointer(): string {
    return plain ? "❯" : pc.bold(pc.green("❯"));
  },
  get radioOn(): string {
    return plain ? "◉" : pc.green("◉");
  },
  get radioOff(): string {
    return plain ? "◯" : pc.dim("◯");
  },
  get warn(): string {
    return plain ? "⚠" : pc.yellow("⚠");
  },
  get resume(): string {
    return plain ? "↻" : pc.yellow("↻");
  },
  get activeDot(): string {
    return plain ? "●" : pc.green("●");
  },
  get bullet(): string {
    return plain ? "·" : pc.dim("·");
  },
} as const;

// A horizontal bar of `width` cells, `filled` of them solid, rest dim.
// tone "amber" (default) = the meter/waste gauge; tone "frog" = savings/positive bars.
export function bar(filled: number, width = 20, tone: "amber" | "frog" = "amber"): string {
  const f = Math.max(0, Math.min(width, Math.round(filled)));
  if (plain) return "█".repeat(f) + "░".repeat(width - f);
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
