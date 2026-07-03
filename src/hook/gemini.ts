import { existsSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import type { HookFsOptions, HookProvider, HookScope } from "./provider.js";
import {
  installSettingsHook,
  settingsHookInstalled,
  uninstallSettingsHook,
} from "./settings-hooks.js";

// Gemini CLI: same hooks shape as Claude Code, in `.gemini/settings.json`
// (project) or `~/.gemini/settings.json` (global), under SessionEnd. Gemini runs
// hooks SYNCHRONOUSLY with a 60s default timeout — safe only because our entry
// is `frugl hook run`, which detaches the real upload and exits immediately.

const LABEL = "Gemini CLI settings";
const SESSION_END_EVENT = "SessionEnd";

function settingsPath(scope: HookScope, opts: HookFsOptions = {}): string {
  const base = scope === "global" ? (opts.home ?? homedir()) : (opts.cwd ?? process.cwd());
  return path.join(base, ".gemini", "settings.json");
}

export const geminiHookProvider: HookProvider = {
  id: "gemini",
  displayName: "Gemini CLI",
  supportsProjectScope: true,
  detect: (opts = {}) => existsSync(path.join(opts.home ?? homedir(), ".gemini")),
  configPath: settingsPath,
  isInstalled: (scope, opts = {}) =>
    settingsHookInstalled(settingsPath(scope, opts), SESSION_END_EVENT, LABEL),
  install: (scope, opts = {}) => {
    const { path: file } = installSettingsHook(settingsPath(scope, opts), SESSION_END_EVENT, LABEL);
    return { status: "installed", path: file };
  },
  uninstall: (scope, opts = {}) =>
    uninstallSettingsHook(settingsPath(scope, opts), SESSION_END_EVENT, LABEL),
};
