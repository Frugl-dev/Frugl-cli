import { existsSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import type { HookFsOptions, HookProvider, HookScope } from "./provider.js";
import { FRUGL_HOOK_COMMAND_RE, HOOK_RUN_COMMAND } from "./provider.js";
import { readJsonObjectFile, writeJsonObjectFile } from "./settings-hooks.js";

// Cursor: hooks live in `.cursor/hooks.json` (project) or `~/.cursor/hooks.json`
// (user). The shape differs from Claude/Gemini settings — entries carry a
// `command` directly, no nested groups: {version: 1, hooks: {stop: [{command}]}}.
// We register under `stop` (agent finished responding) rather than `sessionEnd`:
// an IDE window can stay open for days, so sessionEnd may effectively never
// fire; `stop` is frequent and `hook run`'s cooldown collapses the bursts.

const LABEL = "Cursor hooks";
const STOP_EVENT = "stop";

interface CursorHookEntry {
  command: string;
  [key: string]: unknown;
}
interface CursorHooksFile {
  version?: number;
  hooks?: Record<string, CursorHookEntry[]>;
  [key: string]: unknown;
}

function hooksPath(scope: HookScope, opts: HookFsOptions = {}): string {
  const base = scope === "global" ? (opts.home ?? homedir()) : (opts.cwd ?? process.cwd());
  return path.join(base, ".cursor", "hooks.json");
}

function isFruglEntry(entry: CursorHookEntry): boolean {
  return FRUGL_HOOK_COMMAND_RE.test(entry.command ?? "");
}

function entriesOf(file: CursorHooksFile, event: string): CursorHookEntry[] {
  const entries = file.hooks?.[event];
  return Array.isArray(entries) ? entries : [];
}

export const cursorHookProvider: HookProvider = {
  id: "cursor",
  displayName: "Cursor",
  supportsProjectScope: true,
  detect: (opts = {}) => {
    const home = opts.home ?? homedir();
    return (
      existsSync(path.join(home, ".cursor")) ||
      existsSync(path.join(home, "Library", "Application Support", "Cursor"))
    );
  },
  configPath: hooksPath,
  isInstalled: (scope, opts = {}) => {
    const file = hooksPath(scope, opts);
    if (!existsSync(file)) return false;
    const parsed = readJsonObjectFile(file, LABEL) as CursorHooksFile;
    return Object.keys(parsed.hooks ?? {}).some((event) =>
      entriesOf(parsed, event).some(isFruglEntry),
    );
  },
  install: (scope, opts = {}) => {
    const file = hooksPath(scope, opts);
    const parsed = readJsonObjectFile(file, LABEL) as CursorHooksFile;
    const hooks = parsed.hooks ?? {};
    // Sweep our entry out of EVERY event (an older install may have used a
    // different one), then add the current entry under `stop` — idempotent.
    for (const event of Object.keys(hooks)) {
      const kept = entriesOf(parsed, event).filter((e) => !isFruglEntry(e));
      if (kept.length === 0) delete hooks[event];
      else hooks[event] = kept;
    }
    hooks[STOP_EVENT] = [...entriesOf({ hooks }, STOP_EVENT), { command: HOOK_RUN_COMMAND }];
    parsed.hooks = hooks;
    parsed.version = parsed.version ?? 1;
    writeJsonObjectFile(file, parsed, LABEL);
    return { status: "installed", path: file };
  },
  uninstall: (scope, opts = {}) => {
    const file = hooksPath(scope, opts);
    if (!existsSync(file)) return { path: file, removed: false };
    const parsed = readJsonObjectFile(file, LABEL) as CursorHooksFile;
    if (!parsed.hooks) return { path: file, removed: false };
    let removed = false;
    for (const event of Object.keys(parsed.hooks)) {
      const entries = entriesOf(parsed, event);
      const kept = entries.filter((e) => !isFruglEntry(e));
      if (kept.length < entries.length) removed = true;
      if (kept.length === 0) delete parsed.hooks[event];
      else parsed.hooks[event] = kept;
    }
    if (Object.keys(parsed.hooks).length === 0) delete parsed.hooks;
    if (removed) writeJsonObjectFile(file, parsed, LABEL);
    return { path: file, removed };
  },
};
