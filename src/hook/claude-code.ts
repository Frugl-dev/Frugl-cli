import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { UsageError } from "../lib/errors.js";

// Wires a headless upload into Claude Code's hooks. We register under the
// SessionEnd event (fires once when a session terminates), running the
// non-interactive upload. Entries are identified by their command so install is
// idempotent and uninstall removes only ours, leaving other hooks intact.

export type HookScope = "project" | "global";

const SESSION_END_EVENT = "SessionEnd";
export const UPLOAD_COMMAND = "frugl upload sessions --yes --format json";
const FRUGL_COMMAND_RE = /\bfrugl\s+upload\b/;

export interface HookFsOptions {
  cwd?: string;
  home?: string;
}

interface HookEntry {
  type: string;
  command: string;
}
interface HookGroup {
  matcher?: string;
  hooks: HookEntry[];
}
interface Settings {
  hooks?: Record<string, HookGroup[]>;
  [key: string]: unknown;
}

export function settingsPath(scope: HookScope, opts: HookFsOptions = {}): string {
  const base = scope === "global" ? (opts.home ?? homedir()) : (opts.cwd ?? process.cwd());
  return path.join(base, ".claude", "settings.json");
}

function readSettings(file: string): Settings {
  if (!existsSync(file)) return {};
  let raw: string;
  try {
    raw = readFileSync(file, "utf8");
  } catch (err) {
    throw new UsageError(
      `Cannot read Claude Code settings ${file}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (raw.trim() === "") return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new UsageError(`${file} is not valid JSON — refusing to modify it. Fix it and re-run.`);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new UsageError(`${file} is not a JSON object — refusing to modify it.`);
  }
  return parsed as Settings;
}

function writeSettings(file: string, settings: Settings): void {
  try {
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, `${JSON.stringify(settings, null, 2)}\n`);
  } catch (err) {
    throw new UsageError(
      `Cannot write Claude Code settings ${file}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

function isFruglGroup(group: HookGroup): boolean {
  return (
    Array.isArray(group.hooks) && group.hooks.some((h) => FRUGL_COMMAND_RE.test(h.command ?? ""))
  );
}

function sessionEndGroups(settings: Settings): HookGroup[] {
  const groups = settings.hooks?.[SESSION_END_EVENT];
  return Array.isArray(groups) ? groups : [];
}

export function isInstalled(scope: HookScope, opts: HookFsOptions = {}): boolean {
  const file = settingsPath(scope, opts);
  if (!existsSync(file)) return false;
  return sessionEndGroups(readSettings(file)).some(isFruglGroup);
}

export function installHook(
  scope: HookScope,
  opts: HookFsOptions = {},
): { path: string; command: string } {
  const file = settingsPath(scope, opts);
  const settings = readSettings(file);
  const hooks = settings.hooks ?? {};
  // Drop any prior Frugl entry, then add a fresh one — idempotent.
  const others = sessionEndGroups(settings).filter((g) => !isFruglGroup(g));
  others.push({ hooks: [{ type: "command", command: UPLOAD_COMMAND }] });
  hooks[SESSION_END_EVENT] = others;
  settings.hooks = hooks;
  writeSettings(file, settings);
  return { path: file, command: UPLOAD_COMMAND };
}

export function uninstallHook(
  scope: HookScope,
  opts: HookFsOptions = {},
): { path: string; removed: boolean } {
  const file = settingsPath(scope, opts);
  if (!existsSync(file)) return { path: file, removed: false };
  const settings = readSettings(file);
  if (!settings.hooks || !Array.isArray(settings.hooks[SESSION_END_EVENT])) {
    return { path: file, removed: false };
  }
  const existing = settings.hooks[SESSION_END_EVENT];
  const kept = existing.filter((g) => !isFruglGroup(g));
  const removed = kept.length < existing.length;
  if (kept.length === 0) {
    delete settings.hooks[SESSION_END_EVENT];
  } else {
    settings.hooks[SESSION_END_EVENT] = kept;
  }
  if (Object.keys(settings.hooks).length === 0) delete settings.hooks;
  writeSettings(file, settings);
  return { path: file, removed };
}
