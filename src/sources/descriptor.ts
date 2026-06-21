import path from "node:path";
import type { ProjectGroup, ProviderId } from "./providers.js";
import type { DiscoverOptions, SessionRef } from "./types.js";
import { deriveClaudeProjects, extractWorktreePath } from "./claude-code/project.js";
import { collectToolResultRecords } from "./claude-code/tool-results.js";
import {
  composerIdOf,
  decodeCursorComposer,
  discoverCursorComposers,
  isComposerRef,
} from "./cursor-vscdb.js";
import {
  agentTranscriptId,
  decodeAgentTranscriptCwd,
  decodeCursorAgentTranscript,
  discoverCursorAgentTranscripts,
  isAgentTranscriptRef,
} from "./cursor-agent.js";

// On-disk record layout. The generic walker's decode dispatch keys off this so a
// single code path serves every provider — structurally preventing the
// gemini-style bespoke-parse drift.
export type RecordFormat =
  | { kind: "ndjson" } // one JSON object per line (Claude, Codex, Cursor, Gemini)
  | { kind: "json-array" }; // the whole file is a JSON array (no current provider)

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
  // Additive (039) provider-specific metadata records APPENDED to `records`
  // after the transcript lines — they flow through anonymization and the
  // content hash like any other record. Warnings are surfaced by the walker
  // and never abort the parse (honest failures).
  collectExtraRecords?(ref: SessionRef): Promise<{ records: unknown[]; warnings: string[] }>;
  // Optional discover/decode OVERRIDES for providers whose on-disk store is not a
  // one-file-per-session glob. When `discoverRefs` is present the walker uses it
  // instead of the glob walk; when `decodeRecords` is present the walker uses it
  // instead of readFile + format decode. Cursor IDE uses both: one SQLite store
  // (state.vscdb) holds many composers, so discover enumerates composers and
  // decode reads one composer's `{composer, bubbles}` export. Everything after
  // decode (identity, anonymize, upload) stays on the shared path.
  discoverRefs?(opts?: DiscoverOptions): Promise<SessionRef[]>;
  decodeRecords?(ref: SessionRef): Promise<unknown[]>;
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
    // IDE vscdb composers carry no on-disk project axis (one SQLite store holds
    // every workspace's threads), so they group under a single "cursor" project;
    // the cloud re-derives per-session project identity from the manifest. Legacy
    // cursor-agent transcripts keep the projects/<id> path-segment grouping.
    let projectId: string;
    if (isComposerRef(ref.absolutePath)) {
      projectId = "cursor";
    } else {
      const parts = ref.absolutePath.replace(/\\/g, "/").split("/");
      const projIdx = parts.indexOf("projects");
      projectId =
        projIdx >= 0 && parts[projIdx + 1]
          ? parts[projIdx + 1]!
          : path.basename(path.dirname(path.dirname(ref.absolutePath)));
    }
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
  // spec 039 — size-only metadata for tool-results/*.txt sidecar files; the
  // cloud's Claude adapter aggregates them into offloaded-result metrics.
  collectExtraRecords: (ref) => collectToolResultRecords(ref.absolutePath),
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
  extractMetadata: ({ firstRecord }) => ({
    cwd: readSessionMeta(firstRecord, "cwd"),
    // Codex records git state under session_meta.payload.git (commit_hash,
    // branch, repository_url); mirror Claude by surfacing the branch.
    recordedBranch: readSessionMetaGit(firstRecord, "branch"),
  }),
  deriveProjects: deriveFlatProjects("codex", "Codex sessions"),
};

const cursor: ProviderDescriptor = {
  id: "cursor",
  sourceKind: "cursor",
  // The cloud routes the parse path on sourceKind ("cursor"); the export shape the
  // adapter parses ({composer, bubbles}) is the SAME whether it came from the IDE
  // vscdb or a cursor-agent transcript, so this stays wire-stable.
  displayName: "Cursor",
  formatVersion: "cursor-jsonl-2026-05",
  layout: {
    // "Installed" = the Cursor IDE global state.vscdb exists. (A terminal-only
    // cursor-agent user without the IDE is still discovered via the transcript
    // source below — discoverRefs runs regardless of this probe.)
    probeSegments: [
      "Library",
      "Application Support",
      "Cursor",
      "User",
      "globalStorage",
      "state.vscdb",
    ],
    // Documentation only — cursor uses custom discoverRefs/decodeRecords, not the
    // generic glob walk. These point at the cursor-agent transcript layout that
    // discoverCursorAgentTranscripts globs (cursor-agent.ts).
    rootSegments: [".cursor", "projects"],
    globs: ["**/agent-transcripts/**/*.jsonl"],
  },
  format: { kind: "ndjson" },
  // TWO sources, unified on the same {composer, bubbles} export shape:
  //   1. Cursor IDE composers from state.vscdb (`::composer::`-marked refs).
  //   2. cursor-agent terminal transcripts at
  //      ~/.cursor/projects/**/agent-transcripts/**/*.jsonl (plain .jsonl refs).
  // A terminal-only user has an EMPTY vscdb, so source 2 is the only way their
  // sessions upload; an IDE-only user has no transcripts. discoverRefs returns
  // both and every later hook branches on which kind a ref is.
  discoverRefs: async (opts) => {
    const home = opts?.homeDir !== undefined ? { homeDir: opts.homeDir } : {};
    const [composers, transcripts] = await Promise.all([
      discoverCursorComposers(home),
      discoverCursorAgentTranscripts(home),
    ]);
    return [...composers, ...transcripts];
  },
  decodeRecords: (ref) =>
    isAgentTranscriptRef(ref.absolutePath)
      ? decodeCursorAgentTranscript(ref)
      : decodeCursorComposer(ref),
  // Both ids are UUIDs reused as the session id: the composer's (encoded in the
  // synthetic ref path) or the transcript's `<sessionId>` dir; else path-derived.
  extractNativeId: ({ ref }) =>
    isAgentTranscriptRef(ref.absolutePath)
      ? agentTranscriptId(ref.absolutePath)
      : composerIdOf(ref.absolutePath),
  // cursor-agent transcripts encode the session's cwd in their path, so the
  // opt-in git resolver can attribute a repo + branch (vscdb composers carry no
  // path link → no cwd, honest absence). recordedBranch has no source signal.
  extractMetadata: ({ ref }) => {
    const cwd = isAgentTranscriptRef(ref.absolutePath)
      ? decodeAgentTranscriptCwd(ref.absolutePath)
      : undefined;
    return { cwd };
  },
  deriveProjects: deriveCursorProjects,
};

const gemini: ProviderDescriptor = {
  id: "gemini",
  sourceKind: "gemini",
  displayName: "Gemini",
  formatVersion: "gemini-jsonl-2026-06",
  layout: {
    probeSegments: [".gemini", "tmp"],
    rootSegments: [".gemini", "tmp"],
    // The RICH per-session transcripts live at tmp/<project>/chats/*.jsonl.
    // The sibling tmp/<project>/logs.json is a STRIPPED projection (no tokens,
    // no content arrays, no toolCalls) — collecting it yielded perpetually
    // partial sessions. We collect the chats JSONL instead. (#gemini-compat)
    globs: ["*/chats/*.jsonl"],
  },
  // The chats files are NDJSON: line 1 is the session header, then a `$set`
  // snapshot line, then raw user/gemini turn lines. Routes through the SAME
  // decode/identity path as the other NDJSON providers — no bespoke parse.
  format: { kind: "ndjson" },
  // The header (records[0] / firstRecord) carries `sessionId`.
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

// Codex git state lives one level deeper, under session_meta.payload.git.
function readSessionMetaGit(record: unknown, key: string): string | undefined {
  if (!record || typeof record !== "object") return undefined;
  const r = record as Record<string, unknown>;
  if (r["type"] !== "session_meta") return undefined;
  const payload = r["payload"];
  if (!payload || typeof payload !== "object") return undefined;
  const git = (payload as Record<string, unknown>)["git"];
  if (!git || typeof git !== "object") return undefined;
  return readStr(git, key);
}

export const DESCRIPTORS: readonly ProviderDescriptor[] = [claude, codex, cursor, gemini];

// Individual descriptors, exported for focused extractor/identity unit tests.
export { claude, codex, cursor, gemini };

export function getDescriptor(id: ProviderId): ProviderDescriptor {
  const d = DESCRIPTORS.find((descriptor) => descriptor.id === id);
  if (!d) throw new Error(`unknown provider descriptor: ${id}`);
  return d;
}
