export interface InteractiveOptions {
  json?: boolean | undefined;
  yes?: boolean | undefined;
  confirm?: boolean | undefined;
  // Injectable for tests; defaults to the real stdin TTY status.
  isTTY?: boolean | undefined;
}

// Interactive only in a real terminal session that hasn't opted into a
// non-interactive flag. `--json`, `--yes`/`--yes`, or a non-TTY stdin (CI,
// pipes) all mean: prompt nothing, auto-select everything supported (FR-018).
export function isInteractive(opts: InteractiveOptions): boolean {
  if (opts.json) return false;
  if (opts.yes || opts.confirm) return false;
  return Boolean(opts.isTTY ?? process.stdin.isTTY);
}
