// Central terminal theme for poppi's human-readable output.
//
// All color goes through picocolors, which auto-disables when stdout is not a
// TTY or NO_COLOR is set — so piped/CI output and --json stay plain text.
// Never style JSON output: callers must emit machine-readable JSON raw.

import pc from "picocolors";

// Semantic colors. `poppy` is the brand red used for prompts, CTAs, and the
// headline count; the rest mirror the roles picocolors-based output already
// leaned on (green = success, yellow = caution, gray = secondary, dim = aside).
export const color = {
  poppy: (s: string): string => pc.red(s),
  poppyBold: (s: string): string => pc.bold(pc.red(s)),
  ok: (s: string): string => pc.green(s),
  warn: (s: string): string => pc.yellow(s),
  err: (s: string): string => pc.red(s),
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
  pointer: pc.bold(pc.red("❯")),
  radioOn: pc.green("◉"),
  radioOff: pc.dim("◯"),
  warn: pc.yellow("⚠"),
  resume: pc.yellow("↻"),
  activeDot: pc.green("●"),
  bullet: pc.dim("·"),
} as const;

// A horizontal bar of `width` cells, `filled` of them solid (poppy), rest dim.
export function bar(filled: number, width = 20): string {
  const f = Math.max(0, Math.min(width, Math.round(filled)));
  return color.poppy("█".repeat(f)) + color.dim("░".repeat(width - f));
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
