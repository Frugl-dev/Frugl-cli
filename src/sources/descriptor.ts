import path from "node:path";
import type { ProjectGroup, ProviderId } from "./providers.js";
import type { SessionRef } from "./types.js";
import { deriveClaudeProjects, extractWorktreePath } from "./claude-code/project.js";

// On-disk record layout. The generic walker's decode dispatch keys off this so a
// single code path serves every provider — structurally preventing the
// gemini-style bespoke-parse drift.
export type RecordFormat =
  | { kind: "ndjson" } // one JSON object per line (Claude, Codex, Cursor)
  | { kind: "json-array" }; // the whole file is a JSON array (Gemini)

// What the pure extractors receive: the discovered ref plus the already-decoded
// records (and a convenience first-record handle). No filesystem access here —
// extractors are pure and unit-testable without a temp home.
export interface ExtractContext {
  ref: SessionRef;
  records: unknown[];
  firstRecord: unknown; // records[0] ?? null
}

// A pure-data description of one provider. The genuinely-varying axes (a discover
// glob, a probe path, an id-extraction strategy, optional metadata extraction, and
// on-disk format) are named fields or tiny pure extractors; everything else lives
// once in the generic walker. Adding a provider is adding one object literal.
export interface ProviderDescriptor {
  id: ProviderId;
  // Wire-stable; distinct from `id` (claude.id="claude" but sourceKind="claude-code").
  // Conflating them would silently re-key Claude sessions on the cloud.
  sourceKind: string;
  displayName: string;
  formatVersion: string;
  layout: {
    // Path segments under home whose existence means "installed" (FR-019 probe).
    probeSegments: string[];
    // Glob root, as path segments under home.
    rootSegments: string[];
    // tinyglobby patterns relative to the root.
    globs: string[];
  };
  format: RecordFormat;
  // The source's own session id read from content/path, when present.
  extractNativeId(ctx: ExtractContext): string | undefined;
  // Reuse a valid-UUID native id as the session id. Returning false forces a
  // path-derived id (Claude worktree copies sharing a native id). Default: true.
  allowNativeReuse?(ctx: ExtractContext): boolean;
  // Additive (005) metadata never folded into `records`. Either field may be
  // explicitly undefined; the walker only spreads the ones that are present.
  extractMetadata?(ctx: ExtractContext): {
    cwd?: string | undefined;
    recordedBranch?: string | undefined;
  };
  deriveProjects(refs: SessionRef[]): ProjectGroup[];
}

// ── shared pure helpers ────────────────────────────────────────────────────────

// Reads a non-empty string property off an unknown record, else undefined.
export function readStr(record: unknown, key: string): string | undefined {
  if (!record || typeof record !== "object") return undefined;
  const value = (record as Record<string, unknown>)[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

// First non-empty string value for `key` across records, else undefined.
export function firstNonEmpty(records: unknown[], key: string): string | undefined {
  for (const record of records) {
    const value = readStr(record, key);
    if (value !== undefined) return value;
  }
  return undefined;
}

// The first path segment after `marker` in an absolute path (separator-agnostic).
// Used by Cursor to read its session UUID straight from the file path. Returns
// undefined when the marker is absent or no segment follows it.
export function segmentAfter(absolutePath: string, marker: string): string | undefined {
  const normalized = absolutePath.replace(/\\/g, "/");
  const idx = normalized.lastIndexOf(marker);
  if (idx === -1) return undefined;
  const after = normalized.slice(idx + marker.length);
  const segment = after.split("/")[0];
  return segment && segment.length > 0 ? segment : undefined;
}

// A flat single-group project derivation for providers with no project axis.
function deriveFlatProjects(providerId: ProviderId, displayName: string) {
  return (refs: SessionRef[]): ProjectGroup[] =>
    refs.length === 0
      ? []
      : [
          {
            providerId,
            projectId: providerId,
            displayName,
            sessions: refs,
            sessionCount: refs.length,
          },
        ];
}

// Cursor groups by the "projects/<id>/…" path segment. Bespoke (the RFC keeps
// this and Claude's worktree grouping as named helpers the descriptors reference).
function deriveCursorProjects(refs: SessionRef[]): ProjectGroup[] {
  const byProject = new Map<string, SessionRef[]>();
  for (const ref of refs) {
    const parts = ref.absolutePath.replace(/\\/g, "/").split("/");
    const projIdx = parts.indexOf("projects");
    const projectId =
      projIdx >= 0 && parts[projIdx + 1]
        ? parts[projIdx + 1]!
        : path.basename(path.dirname(path.dirname(ref.absolutePath)));
    const sessions = byProject.get(projectId);
    if (sessions) sessions.push(ref);
    else byProject.set(projectId, [ref]);
  }
  return [...byProject.entries()].map(([projectId, sessions]) => ({
    providerId: "cursor" as ProviderId,
    projectId,
    displayName: projectId,
    sessions,
    sessionCount: sessions.length,
  }));
}

// ── the four providers, as data ────────────────────────────────────────────────

const claude: ProviderDescriptor = {
  id: "claude",
  sourceKind: "claude-code",
  displayName: "Claude Code",
  formatVersion: "claude-jsonl-2026-04",
  layout: {
    probeSegments: [".claude", "projects"],
    rootSegments: [".claude", "projects"],
    globs: ["*/*.jsonl"],
  },
  format: { kind: "ndjson" },
  extractNativeId: ({ firstRecord }) => readStr(firstRecord, "sessionId"),
  // Claude reuses one session UUID across a main checkout and its worktree
  // copies; only the main checkout keeps the native id so the two never collide
  // on the cloud's UUID primary key.
  allowNativeReuse: ({ ref }) => extractWorktreePath(ref.absolutePath) === null,
  extractMetadata: ({ records }) => ({
    cwd: firstNonEmpty(records, "cwd"),
    recordedBranch: firstNonEmpty(records, "gitBranch"),
  }),
  deriveProjects: deriveClaudeProjects,
};

const codex: ProviderDescriptor = {
  id: "codex",
  sourceKind: "codex",
  displayName: "Codex",
  formatVersion: "codex-jsonl-2026-05",
  layout: {
    probeSegments: [".codex", "sessions"],
    rootSegments: [".codex", "sessions"],
    globs: ["**/*.jsonl"],
  },
  format: { kind: "ndjson" },
  extractNativeId: ({ firstRecord }) => readSessionMeta(firstRecord, "id"),
  extractMetadata: ({ firstRecord }) => ({ cwd: readSessionMeta(firstRecord, "cwd") }),
  deriveProjects: deriveFlatProjects("codex", "Codex sessions"),
};

const cursor: ProviderDescriptor = {
  id: "cursor",
  sourceKind: "cursor",
  displayName: "Cursor",
  formatVersion: "cursor-jsonl-2026-05",
  layout: {
    probeSegments: [
      "Library",
      "Application Support",
      "Cursor",
      "User",
      "globalStorage",
      "state.vscdb",
    ],
    rootSegments: [".cursor", "projects"],
    globs: ["**/agent-transcripts/**/*.jsonl"],
  },
  format: { kind: "ndjson" },
  // Cursor's session UUID is the first path segment after "/agent-transcripts/".
  extractNativeId: ({ ref }) => segmentAfter(ref.absolutePath, "/agent-transcripts/"),
  deriveProjects: deriveCursorProjects,
};

const gemini: ProviderDescriptor = {
  id: "gemini",
  sourceKind: "gemini",
  displayName: "Gemini",
  formatVersion: "gemini-json-2026-05",
  layout: {
    probeSegments: [".gemini", "tmp"],
    rootSegments: [".gemini", "tmp"],
    globs: ["*/logs.json"],
  },
  // Routes through the SAME decode/identity path as the NDJSON providers; this
  // is what removes gemini's bespoke JSON.parse and its divergent error handling.
  format: { kind: "json-array" },
  extractNativeId: ({ firstRecord }) => readStr(firstRecord, "sessionId"),
  deriveProjects: deriveFlatProjects("gemini", "Gemini sessions"),
};

// Codex nests its id/cwd under a leading `{ type: "session_meta", payload }`.
function readSessionMeta(record: unknown, key: string): string | undefined {
  if (!record || typeof record !== "object") return undefined;
  const r = record as Record<string, unknown>;
  if (r["type"] !== "session_meta") return undefined;
  const payload = r["payload"];
  if (!payload || typeof payload !== "object") return undefined;
  return readStr(payload, key);
}

export const DESCRIPTORS: readonly ProviderDescriptor[] = [claude, codex, cursor, gemini];

// Individual descriptors, exported for focused extractor/identity unit tests.
export { claude, codex, cursor, gemini };

export function getDescriptor(id: ProviderId): ProviderDescriptor {
  const d = DESCRIPTORS.find((descriptor) => descriptor.id === id);
  if (!d) throw new Error(`unknown provider descriptor: ${id}`);
  return d;
}
