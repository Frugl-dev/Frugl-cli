import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { UsageError } from "../lib/errors.js";
import { FRUGL_HOOK_COMMAND_RE, HOOK_RUN_COMMAND } from "./provider.js";

// Claude Code and Gemini CLI share the same hooks shape inside a settings.json:
// `hooks.<Event>` is an array of groups, each holding `hooks: [{type, command}]`
// entries. This module owns that shape once; the two providers differ only in
// directory name and event. Entries are identified by their command so install
// is idempotent and uninstall removes only ours, leaving other hooks intact.

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

// Read a JSON object file, refusing to touch anything malformed — a hook install
// must never clobber a settings file the user (or another tool) hand-maintains.
export function readJsonObjectFile(file: string, label: string): Record<string, unknown> {
  if (!existsSync(file)) return {};
  let raw: string;
  try {
    raw = readFileSync(file, "utf8");
  } catch (err) {
    throw new UsageError(
      `Cannot read ${label} ${file}: ${err instanceof Error ? err.message : String(err)}`,
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
  return parsed as Record<string, unknown>;
}

export function writeJsonObjectFile(
  file: string,
  value: Record<string, unknown>,
  label: string,
): void {
  try {
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
  } catch (err) {
    throw new UsageError(
      `Cannot write ${label} ${file}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

function isFruglGroup(group: HookGroup): boolean {
  return (
    Array.isArray(group.hooks) &&
    group.hooks.some((h) => FRUGL_HOOK_COMMAND_RE.test(h.command ?? ""))
  );
}

function eventGroups(settings: Settings, event: string): HookGroup[] {
  const groups = settings.hooks?.[event];
  return Array.isArray(groups) ? groups : [];
}

export function settingsHookInstalled(file: string, event: string, label: string): boolean {
  if (!existsSync(file)) return false;
  return eventGroups(readJsonObjectFile(file, label) as Settings, event).some(isFruglGroup);
}

export function installSettingsHook(
  file: string,
  event: string,
  label: string,
): { path: string; command: string } {
  const settings = readJsonObjectFile(file, label) as Settings;
  const hooks = settings.hooks ?? {};
  // Drop any prior Frugl entry (including a legacy direct-upload one), then add
  // a fresh one — idempotent, and installs double as upgrades.
  const others = eventGroups(settings, event).filter((g) => !isFruglGroup(g));
  others.push({ hooks: [{ type: "command", command: HOOK_RUN_COMMAND }] });
  hooks[event] = others;
  settings.hooks = hooks;
  writeJsonObjectFile(file, settings, label);
  return { path: file, command: HOOK_RUN_COMMAND };
}

export function uninstallSettingsHook(
  file: string,
  event: string,
  label: string,
): { path: string; removed: boolean } {
  if (!existsSync(file)) return { path: file, removed: false };
  const settings = readJsonObjectFile(file, label) as Settings;
  if (!settings.hooks || !Array.isArray(settings.hooks[event])) {
    return { path: file, removed: false };
  }
  const existing = settings.hooks[event];
  const kept = existing.filter((g) => !isFruglGroup(g));
  const removed = kept.length < existing.length;
  if (kept.length === 0) {
    delete settings.hooks[event];
  } else {
    settings.hooks[event] = kept;
  }
  if (Object.keys(settings.hooks).length === 0) delete settings.hooks;
  writeJsonObjectFile(file, settings, label);
  return { path: file, removed };
}
