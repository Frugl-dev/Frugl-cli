import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { FruglError } from "../../lib/errors.js";
import { EXIT } from "../../lib/exit-codes.js";

// ── Synthesized context snapshots (codex / gemini / cursor) ─────────────────────
//
// These tools expose NO headless "/context" command (verified 2026-07-02), so a
// Claude-style provider-reported window breakdown is impossible. What IS
// knowable, deterministically and for free, is the context LOADOUT each tool
// injects: memory/instruction files (AGENTS.md, GEMINI.md, .cursor/rules) and
// declared MCP servers. This runner family enumerates those artifacts and
// measures their SIZE (character count) client-side — file contents never enter
// the payload (names + sizes only, matching the /context capture's fidelity),
// and the cloud adapter derives estimated tokens (chars/4).
//
// The payload is a small JSON document (schema "frugl.context-artifacts") —
// distinct from Claude's raw stdout text — parsed by the cloud's artifacts
// snapshot adapter (packages/adapters/src/context-snapshot/artifacts.ts). It
// deliberately excludes the capture timestamp so an unchanged loadout hashes
// identically and the spec-052 no-change gate can skip the upload.

export const ARTIFACTS_SCHEMA = "frugl.context-artifacts";
export const ARTIFACTS_SCHEMA_VERSION = 1;

export type ArtifactsTool = "codex" | "gemini" | "cursor";

export interface ArtifactItem {
  // The two categories a file-level capture can honestly claim. Everything a
  // running session adds (system prompt, tools, messages) is unknowable here.
  category: "memory_files" | "mcp_tools";
  // Display identifier — a `~/`-relative or repo-relative path, or an MCP
  // server name. NEVER an absolute path (no usernames) and never contents.
  name: string;
  // Measured content size in characters; null for declared-but-unmeasured
  // items (MCP servers — their injected footprint isn't knowable from config).
  chars: number | null;
}

export interface ArtifactsPayload {
  schema: typeof ARTIFACTS_SCHEMA;
  schema_version: typeof ARTIFACTS_SCHEMA_VERSION;
  tool: ArtifactsTool;
  items: ArtifactItem[];
}

export interface ArtifactCaptureOptions {
  cwd?: string;
  homeDir?: string;
}

function home(opts: ArtifactCaptureOptions): string {
  return opts.homeDir ?? homedir();
}

function cwdOf(opts: ArtifactCaptureOptions): string {
  return opts.cwd ?? process.cwd();
}

// Measure a file if it exists and is a real file; undefined otherwise. Reads
// are for MEASUREMENT only — the content is discarded immediately.
function measure(filePath: string): number | undefined {
  try {
    if (!existsSync(filePath) || !statSync(filePath).isFile()) return undefined;
    return readFileSync(filePath, "utf8").length;
  } catch {
    return undefined;
  }
}

// The repo root for a cwd: nearest ancestor containing `.git`. Falls back to
// the cwd itself when no repo is found (project files then resolve from cwd).
function repoRoot(cwd: string): string {
  let dir = cwd;
  for (;;) {
    if (existsSync(path.join(dir, ".git"))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return cwd;
    dir = parent;
  }
}

// Project-level instruction files: the named file at the repo root and (when
// different) at the cwd — the chain both Codex and Gemini walk. Deduped.
function projectMemoryItems(
  fileName: string,
  opts: ArtifactCaptureOptions,
  label: string,
): ArtifactItem[] {
  const cwd = cwdOf(opts);
  const root = repoRoot(cwd);
  const candidates = [...new Set([path.join(root, fileName), path.join(cwd, fileName)])];
  const items: ArtifactItem[] = [];
  for (const candidate of candidates) {
    const chars = measure(candidate);
    if (chars === undefined) continue;
    const suffix = candidate === path.join(root, fileName) ? "project" : "cwd";
    items.push({ category: "memory_files", name: `${fileName} (${label} ${suffix})`, chars });
  }
  return items;
}

function globalMemoryItem(relPath: string, opts: ArtifactCaptureOptions): ArtifactItem[] {
  const chars = measure(path.join(home(opts), relPath));
  return chars === undefined ? [] : [{ category: "memory_files", name: `~/${relPath}`, chars }];
}

// `[mcp_servers.<name>]` table headers in codex's config.toml — names only.
const CODEX_MCP_HEADER = /^\[mcp_servers\.(?:"([^"]+)"|([^\]."]+))\]\s*$/;

function codexMcpItems(opts: ArtifactCaptureOptions): ArtifactItem[] {
  const configPath = path.join(home(opts), ".codex", "config.toml");
  let text: string;
  try {
    text = readFileSync(configPath, "utf8");
  } catch {
    return [];
  }
  const items: ArtifactItem[] = [];
  for (const line of text.split("\n")) {
    const m = CODEX_MCP_HEADER.exec(line.trim());
    const name = m?.[1] ?? m?.[2];
    if (name) items.push({ category: "mcp_tools", name, chars: null });
  }
  return items;
}

function geminiMcpItems(opts: ArtifactCaptureOptions): ArtifactItem[] {
  const settingsPath = path.join(home(opts), ".gemini", "settings.json");
  try {
    const parsed: unknown = JSON.parse(readFileSync(settingsPath, "utf8"));
    const servers =
      parsed && typeof parsed === "object"
        ? (parsed as Record<string, unknown>).mcpServers
        : undefined;
    if (!servers || typeof servers !== "object" || Array.isArray(servers)) return [];
    return Object.keys(servers).map((name) => ({
      category: "mcp_tools" as const,
      name,
      chars: null,
    }));
  } catch {
    return [];
  }
}

// Cursor project rules: .cursor/rules/*.mdc (modern), .cursorrules (legacy),
// plus the AGENTS.md standard Cursor also reads. User-level rules live inside
// the IDE state, not on disk — honest absence.
function cursorRuleItems(opts: ArtifactCaptureOptions): ArtifactItem[] {
  const root = repoRoot(cwdOf(opts));
  const items: ArtifactItem[] = [];
  const rulesDir = path.join(root, ".cursor", "rules");
  try {
    for (const entry of readdirSync(rulesDir)) {
      if (!entry.endsWith(".mdc") && !entry.endsWith(".md")) continue;
      const chars = measure(path.join(rulesDir, entry));
      if (chars !== undefined) {
        items.push({ category: "memory_files", name: `.cursor/rules/${entry}`, chars });
      }
    }
  } catch {
    // no rules dir — fine
  }
  const legacy = measure(path.join(root, ".cursorrules"));
  if (legacy !== undefined)
    items.push({ category: "memory_files", name: ".cursorrules", chars: legacy });
  return items;
}

function buildPayload(tool: ArtifactsTool, items: ArtifactItem[]): string {
  if (items.length === 0) {
    // Fail-closed like an empty /context stdout: nothing found means nothing
    // to snapshot — exit non-zero with NO upload rather than an empty row.
    throw new FruglError(
      `Found no ${tool} context artifacts to snapshot (no instruction files or MCP declarations).`,
      EXIT.GENERIC_FAILURE,
    );
  }
  const payload: ArtifactsPayload = {
    schema: ARTIFACTS_SCHEMA,
    schema_version: ARTIFACTS_SCHEMA_VERSION,
    tool,
    items,
  };
  return JSON.stringify(payload);
}

export function captureCodexArtifacts(opts: ArtifactCaptureOptions = {}): string {
  return buildPayload("codex", [
    ...globalMemoryItem(".codex/AGENTS.md", opts),
    ...projectMemoryItems("AGENTS.md", opts, "codex"),
    ...codexMcpItems(opts),
  ]);
}

export function captureGeminiArtifacts(opts: ArtifactCaptureOptions = {}): string {
  return buildPayload("gemini", [
    ...globalMemoryItem(".gemini/GEMINI.md", opts),
    ...projectMemoryItems("GEMINI.md", opts, "gemini"),
    ...geminiMcpItems(opts),
  ]);
}

export function captureCursorArtifacts(opts: ArtifactCaptureOptions = {}): string {
  return buildPayload("cursor", [
    ...projectMemoryItems("AGENTS.md", opts, "cursor"),
    ...cursorRuleItems(opts),
  ]);
}
