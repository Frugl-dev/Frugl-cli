import { access, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { glob } from "tinyglobby";
import type { CursorComposerExport } from "./cursor-vscdb.js";
import { parseNdjson } from "./ndjson.js";
import type { SessionRef } from "./types.js";

// ── Cursor "cursor-agent" terminal transcripts ──────────────────────────────────
//
// The Cursor *terminal* agent (`cursor-agent`) writes a flat NDJSON transcript
// per session at:
//
//   ~/.cursor/projects/<encoded-cwd>/agent-transcripts/<sessionId>/<sessionId>.jsonl
//
// This is a DISTINCT source from the Cursor IDE's SQLite store (cursor-vscdb.ts):
// the IDE keeps chat in `state.vscdb`, while the terminal agent writes these
// JSONL files. A machine that only uses `cursor-agent` from the terminal has an
// EMPTY vscdb, so without this source its sessions never upload at all.
//
// Each line is one turn:
//   { role: "user"|"assistant", message: { content: [{ type: "text", text },
//                                                      { type: "tool_use", ... }] } }
// plus bare `{ type: "turn_ended", status }` markers (no role). We convert each
// transcript into the SAME `{ composer, bubbles }` export shape the cloud Cursor
// adapter parses (packages/adapters/src/cursor.ts) — so everything downstream
// (identity, anonymize, upload, parse) stays on the shared path.

interface HomeOptions {
  homeDir?: string;
}

function home(opts?: HomeOptions): string {
  return opts?.homeDir ?? homedir();
}

// The session id is the dir name right after `/agent-transcripts/` (a UUID that
// also names the .jsonl file). Reused as the canonical session id when valid.
const TRANSCRIPT_MARKER = "/agent-transcripts/";

const CURSOR_AGENT_SEGMENTS = [".cursor", "projects"];

// The Cursor IDE's global SQLite store (cursor-vscdb.ts's probe path).
const CURSOR_IDE_SEGMENTS = [
  "Library",
  "Application Support",
  "Cursor",
  "User",
  "globalStorage",
  "state.vscdb",
];

// Existence with FR-019 semantics: genuinely-absent → false; any OTHER error
// (e.g. EACCES) propagates rather than being silently swallowed.
async function pathExists(target: string): Promise<boolean> {
  try {
    await access(target);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw err;
  }
}

// Cursor is "installed" if EITHER source is present: the IDE global store OR the
// cursor-agent transcripts root. The single-path probe would miss a terminal-only
// user (no IDE), whose sessions this source is the only way to upload.
export async function cursorInstalled(opts?: HomeOptions): Promise<boolean> {
  const h = home(opts);
  const [ide, agent] = await Promise.all([
    pathExists(path.join(h, ...CURSOR_IDE_SEGMENTS)),
    pathExists(path.join(h, ...CURSOR_AGENT_SEGMENTS)),
  ]);
  return ide || agent;
}

// A ref points at a cursor-agent transcript (a real .jsonl file) rather than a
// vscdb composer (which carries the `::composer::` marker).
export function isAgentTranscriptRef(absolutePath: string): boolean {
  return absolutePath.replace(/\\/g, "/").includes(TRANSCRIPT_MARKER);
}

// The session id encoded in a transcript ref path (the dir after the marker).
export function agentTranscriptId(absolutePath: string): string | undefined {
  const normalized = absolutePath.replace(/\\/g, "/");
  const idx = normalized.lastIndexOf(TRANSCRIPT_MARKER);
  if (idx === -1) return undefined;
  const after = normalized.slice(idx + TRANSCRIPT_MARKER.length);
  const segment = after.split("/")[0];
  return segment && segment.length > 0 ? segment : undefined;
}

// Decode the working directory from the `projects/<encoded-cwd>` path segment.
// cursor-agent encodes the cwd by replacing every "/" with "-" and dropping the
// leading slash (mirrors Claude Code's project encoding). The decode is lossy —
// a directory whose real name contains "-" round-trips wrong — but the only
// consumer is the opt-in git resolver, which fail-closes (missing-dir) on a path
// that does not exist, so a bad decode yields no branch rather than a wrong one.
export function decodeAgentTranscriptCwd(absolutePath: string): string | undefined {
  const normalized = absolutePath.replace(/\\/g, "/");
  const match = normalized.match(/\.cursor\/projects\/([^/]+)\/agent-transcripts\//);
  const encoded = match?.[1];
  if (!encoded) return undefined;
  return `/${encoded.replace(/-/g, "/")}`;
}

// Concatenate the text parts of a turn's message. `tool_use` parts carry no
// canonical home in the `{composer, bubbles}` shape (its bubbles are text-only),
// so they are dropped here — the same fidelity ceiling the cloud Cursor adapter
// already documents (tool detail unavailable for Cursor).
function textOfMessage(message: unknown): string {
  if (typeof message === "string") return message;
  if (!message || typeof message !== "object") return "";
  const content = (message as Record<string, unknown>).content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const part of content) {
    if (part && typeof part === "object") {
      const p = part as Record<string, unknown>;
      if (p.type === "text" && typeof p.text === "string" && p.text.length > 0) {
        parts.push(p.text);
      }
    }
  }
  return parts.join("\n");
}

// Convert a flat cursor-agent transcript into the cloud adapter's export shape.
// Returns null when no user/assistant turn is present (an empty/marker-only file
// is skipped, not an error). Exported for focused unit tests.
export function agentTranscriptToExport(
  records: unknown[],
  composerId: string,
): CursorComposerExport | null {
  const headers: { bubbleId: string; type: number }[] = [];
  const bubbles: Record<string, { type?: number; text?: string }> = {};
  let i = 0;
  for (const record of records) {
    if (!record || typeof record !== "object") continue;
    const role = (record as Record<string, unknown>).role;
    // type 1 = user, 2 = assistant (matches cursor-vscdb + the cloud adapter).
    // Bare `turn_ended` (and any other roleless) lines carry no turn.
    const type = role === "user" ? 1 : role === "assistant" ? 2 : 0;
    if (type === 0) continue;
    const bubbleId = `b${i++}`;
    headers.push({ bubbleId, type });
    bubbles[bubbleId] = { type, text: textOfMessage((record as Record<string, unknown>).message) };
  }
  if (headers.length === 0) return null;
  return { composer: { composerId, fullConversationHeadersOnly: headers }, bubbles };
}

// Discover one SessionRef per cursor-agent transcript file. Mirrors the generic
// walker's glob→stat→ref shape; a missing `~/.cursor/projects` root yields [].
export async function discoverCursorAgentTranscripts(opts?: HomeOptions): Promise<SessionRef[]> {
  const root = path.join(home(opts), ...CURSOR_AGENT_SEGMENTS);
  const files = await glob(["**/agent-transcripts/**/*.jsonl"], {
    cwd: root,
    absolute: true,
    dot: false,
  }).catch(() => []);
  const refs: SessionRef[] = [];
  for (const file of files) {
    const resolved = path.resolve(file);
    const stats = await stat(resolved).catch(() => null);
    if (!stats?.isFile()) continue;
    refs.push({
      sourceKind: "cursor",
      absolutePath: resolved,
      byteSizeOnDisk: stats.size,
      mtimeMs: stats.mtimeMs,
    });
  }
  return refs;
}

// Decode one transcript ref into the single-element export array the pipeline
// anonymizes + uploads: `[{ composer, bubbles }]` (one NDJSON line, parsed by
// the cloud adapter as one export). An unreadable/empty transcript yields [].
export async function decodeCursorAgentTranscript(ref: SessionRef): Promise<unknown[]> {
  const composerId = agentTranscriptId(ref.absolutePath);
  if (!composerId) return [];
  const text = await readFile(ref.absolutePath, "utf8").catch(() => null);
  if (text === null) return [];
  const exp = agentTranscriptToExport(parseNdjson(text), composerId);
  return exp ? [exp] : [];
}
