import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { UsageError } from "../lib/errors.js";
import type { HookFsOptions, HookInstallResult, HookProvider, HookScope } from "./provider.js";
import { HOOK_RUN_ARGV } from "./provider.js";

// Codex CLI: the trigger surface is the root-table `notify` key in
// ~/.codex/config.toml (fires on agent-turn-complete with a JSON payload argv —
// `hook run` tolerates and ignores it). There is no project-scoped config.
//
// We deliberately do NOT parse/serialize the whole TOML: a round-trip through a
// parser would reorder keys and drop comments in a file users hand-edit. The
// edit is line-based and touches exactly one line in the root table (everything
// before the first `[section]` header), leaving the rest byte-identical.
// `notify` is a single slot, so a foreign value is a conflict we surface —
// never clobber someone else's automation.

const LABEL = "Codex config";
const NOTIFY_LINE = `notify = [${HOOK_RUN_ARGV.map((a) => JSON.stringify(a)).join(", ")}]`;
// A complete single-line notify assignment we can safely replace/remove.
const NOTIFY_RE = /^\s*notify\s*=/;
const NOTIFY_SINGLE_LINE_RE = /^\s*notify\s*=\s*\[[^\]]*\]\s*(#.*)?$/;

function configPath(_scope: HookScope, opts: HookFsOptions = {}): string {
  return path.join(opts.home ?? homedir(), ".codex", "config.toml");
}

function readLines(file: string): string[] {
  let raw: string;
  try {
    raw = readFileSync(file, "utf8");
  } catch (err) {
    throw new UsageError(
      `Cannot read ${LABEL} ${file}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  return raw.split("\n");
}

function writeLines(file: string, lines: string[]): void {
  try {
    mkdirSync(path.dirname(file), { recursive: true });
    let content = lines.join("\n");
    if (!content.endsWith("\n")) content += "\n";
    writeFileSync(file, content);
  } catch (err) {
    throw new UsageError(
      `Cannot write ${LABEL} ${file}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

// Index one past the last root-table line (the first `[section]` header, or EOF).
function rootRegionEnd(lines: string[]): number {
  const headerAt = lines.findIndex((l) => /^\s*\[/.test(l));
  return headerAt === -1 ? lines.length : headerAt;
}

type NotifyState =
  | { kind: "absent" }
  | { kind: "ours"; line: number }
  | { kind: "foreign"; line: number };

function findNotify(lines: string[]): NotifyState {
  const end = rootRegionEnd(lines);
  for (let i = 0; i < end; i++) {
    const line = lines[i]!;
    if (!NOTIFY_RE.test(line)) continue;
    // A multi-line array (or anything else we can't fully see on one line) is
    // treated as foreign: we won't attempt a partial edit.
    if (NOTIFY_SINGLE_LINE_RE.test(line) && /frugl/.test(line)) return { kind: "ours", line: i };
    return { kind: "foreign", line: i };
  }
  return { kind: "absent" };
}

export const codexHookProvider: HookProvider = {
  id: "codex",
  displayName: "Codex CLI",
  supportsProjectScope: false,
  detect: (opts = {}) => existsSync(path.join(opts.home ?? homedir(), ".codex")),
  configPath,
  isInstalled: (scope, opts = {}) => {
    const file = configPath(scope, opts);
    if (!existsSync(file)) return false;
    return findNotify(readLines(file)).kind === "ours";
  },
  install: (scope, opts = {}): HookInstallResult => {
    const file = configPath(scope, opts);
    if (!existsSync(file)) {
      writeLines(file, [NOTIFY_LINE]);
      return { status: "installed", path: file };
    }
    const lines = readLines(file);
    const state = findNotify(lines);
    if (state.kind === "foreign") {
      return {
        status: "conflict",
        path: file,
        reason: "config.toml already sets `notify` to another command — leaving it untouched",
      };
    }
    if (state.kind === "ours") {
      lines[state.line] = NOTIFY_LINE;
    } else {
      // Insert at the end of the root table so the key stays in the only region
      // where TOML treats it as top-level.
      lines.splice(rootRegionEnd(lines), 0, NOTIFY_LINE);
    }
    writeLines(file, lines);
    return { status: "installed", path: file };
  },
  uninstall: (scope, opts = {}) => {
    const file = configPath(scope, opts);
    if (!existsSync(file)) return { path: file, removed: false };
    const lines = readLines(file);
    const state = findNotify(lines);
    if (state.kind !== "ours") return { path: file, removed: false };
    lines.splice(state.line, 1);
    writeLines(file, lines);
    return { path: file, removed: true };
  },
};
