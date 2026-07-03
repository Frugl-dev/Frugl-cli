import { stat } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { glob } from "tinyglobby";
import type { SessionRef } from "./types.js";

// ── Cursor IDE SQLite (state.vscdb) extraction ──────────────────────────────────
//
// The Cursor *IDE* keeps every chat thread in SQLite, NOT in on-disk JSONL like
// the `cursor-agent` terminal CLI. Each thread ("composer") is a `composerData:`
// row in the `cursorDiskKV` key/value table; its individual message bubbles are
// SEPARATE `bubbleId:<composerId>:<bubbleId>` rows. We read the global store plus
// every per-workspace store, and emit ONE portable JSON export per non-empty
// composer — exactly the `{ composer, bubbles }` shape the cloud Cursor adapter
// already parses (packages/adapters/src/cursor.ts).
//
// This is a distinct discover/decode code path from the file-glob walker because
// one physical file (state.vscdb) holds MANY sessions; the descriptor's
// discoverRefs/decodeRecords hooks (descriptor.ts) plug it into the otherwise
// shared identity → anonymize → upload pipeline so nothing downstream diverges.
//
// HONEST GAP: on a freshly-checked dev machine the composers are often empty
// (`fullConversationHeadersOnly: []`, no bubble rows) and content is
// blob-encrypted, so end-to-end live validation may be impossible. We build to
// the documented schema and validate against synthetic fixtures; empty composers
// are skipped (not errors).

// Marker appended to a ref's absolutePath so one physical vscdb yields a unique,
// stable path per composer. Filesystem ops (hash/stat/resume re-check) strip it
// back to the real file via `vscdbFilePath`. Chosen to never appear in a real
// path and to be stable across runs (so the derived session UUID is stable).
const COMPOSER_MARKER = "::composer::";

// One message bubble in the export. Besides the text, Cursor sometimes persists
// per-bubble token counts, the resolved model, and tool-call telemetry
// (`toolFormerData`). Tool telemetry is SIZE-ONLY by construction: the name,
// completion status, and a client-side character count of the result — raw
// args/results never enter the export (fail-closed, Principle VI).
export interface CursorExportBubble {
  type?: number;
  text?: string;
  tokenCount?: { inputTokens?: number; outputTokens?: number };
  modelInfo?: { modelName?: string };
  toolCalls?: { name: string; status?: string; resultChars?: number }[];
}

// The export object one composer becomes — matches the cloud adapter's
// CursorExport. Token/model fields ride along when Cursor persisted them.
export interface CursorComposerExport {
  composer: {
    composerId: string;
    name?: string;
    workspaceName?: string;
    createdAt?: number;
    lastUpdatedAt?: number;
    fullConversationHeadersOnly: { bubbleId: string; type: number }[];
    modelConfig?: { modelName?: string };
    usageData?: Record<string, unknown>;
  };
  bubbles: Record<string, CursorExportBubble>;
}

// True when a ref points at a composer inside a vscdb (vs a plain file).
export function isComposerRef(absolutePath: string): boolean {
  return absolutePath.includes(COMPOSER_MARKER);
}

// The real on-disk vscdb path for a (possibly composer-suffixed) ref path. Used
// by filesystem ops that must touch the actual file (hashing, stat, resume).
export function vscdbFilePath(absolutePath: string): string {
  const idx = absolutePath.indexOf(COMPOSER_MARKER);
  return idx === -1 ? absolutePath : absolutePath.slice(0, idx);
}

// The composerId encoded in a composer ref path, if any.
export function composerIdOf(absolutePath: string): string | undefined {
  const idx = absolutePath.indexOf(COMPOSER_MARKER);
  return idx === -1 ? undefined : absolutePath.slice(idx + COMPOSER_MARKER.length);
}

function composerRefPath(vscdbPath: string, composerId: string): string {
  return `${vscdbPath}${COMPOSER_MARKER}${composerId}`;
}

interface HomeOptions {
  homeDir?: string;
}

function home(opts?: HomeOptions): string {
  return opts?.homeDir ?? homedir();
}

// macOS layout. Cursor on Linux/Windows uses different roots; we glob the macOS
// path (the documented + on-machine location) and tolerate absence elsewhere —
// discovery returns [] when nothing matches (honest, never throws).
const CURSOR_USER_SEGMENTS = ["Library", "Application Support", "Cursor", "User"];

// Every state.vscdb under the Cursor User dir: the one global store plus one per
// workspace. tinyglobby returns absolute paths; a missing root yields [].
async function findVscdbFiles(opts?: HomeOptions): Promise<string[]> {
  const root = path.join(home(opts), ...CURSOR_USER_SEGMENTS);
  const files = await glob(["globalStorage/state.vscdb", "workspaceStorage/*/state.vscdb"], {
    cwd: root,
    absolute: true,
    dot: false,
  }).catch(() => []);
  // De-dupe + keep only real files.
  const seen = new Set<string>();
  const out: string[] = [];
  for (const f of files) {
    const resolved = path.resolve(f);
    if (seen.has(resolved)) continue;
    seen.add(resolved);
    const stats = await stat(resolved).catch(() => null);
    if (stats?.isFile()) out.push(resolved);
  }
  return out;
}

// Open a vscdb read-only. SQLite's immutable/read-only open never mutates the
// file, so a live Cursor process holding it is fine. Returns null on any open
// failure (locked, corrupt, wrong file) — an unreadable store is skipped, not
// fatal (honest failure; the rest of the upload proceeds).
function openReadOnly(file: string): DatabaseSync | null {
  try {
    return new DatabaseSync(file, { readOnly: true });
  } catch {
    return null;
  }
}

function asObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function parseJson(value: unknown): unknown {
  if (typeof value === "string") {
    try {
      return JSON.parse(value);
    } catch {
      return null;
    }
  }
  // node:sqlite returns TEXT as string; BLOBs come back as Uint8Array.
  if (value instanceof Uint8Array) {
    try {
      return JSON.parse(Buffer.from(value).toString("utf8"));
    } catch {
      return null;
    }
  }
  return null;
}

// Read every composer row's id from a vscdb. Each `composerData:<id>` key. A
// store with no `cursorDiskKV` table (an empty/placeholder file, or a vscdb from
// a Cursor version with a different schema) yields [] — honest skip, not an error.
function listComposerIds(db: DatabaseSync): string[] {
  let rows: { key: string }[];
  try {
    rows = db.prepare("SELECT key FROM cursorDiskKV WHERE key LIKE 'composerData:%'").all() as {
      key: string;
    }[];
  } catch {
    return [];
  }
  return rows.map((r) => r.key.slice("composerData:".length)).filter((id) => id.length > 0);
}

function readComposerValue(db: DatabaseSync, composerId: string): Record<string, unknown> | null {
  let row: { value: unknown } | undefined;
  try {
    row = db
      .prepare("SELECT value FROM cursorDiskKV WHERE key = ?")
      .get(`composerData:${composerId}`) as { value: unknown } | undefined;
  } catch {
    return null;
  }
  if (!row) return null;
  return asObject(parseJson(row.value));
}

function readBubble(
  db: DatabaseSync,
  composerId: string,
  bubbleId: string,
): CursorExportBubble | null {
  let row: { value: unknown } | undefined;
  try {
    row = db
      .prepare("SELECT value FROM cursorDiskKV WHERE key = ?")
      .get(`bubbleId:${composerId}:${bubbleId}`) as { value: unknown } | undefined;
  } catch {
    return null;
  }
  if (!row) return null;
  const obj = asObject(parseJson(row.value));
  if (!obj) return null;
  const out: CursorExportBubble = {};
  if (typeof obj.type === "number") out.type = obj.type;
  if (typeof obj.text === "string") out.text = obj.text;
  // Per-bubble telemetry, when Cursor persisted it. tokenCount is zero-filled
  // on unmeasured bubbles — the cloud adapter treats all-zero pairs as absent,
  // so passing them through verbatim stays honest.
  const tokenCount = asObject(obj.tokenCount);
  if (tokenCount) {
    const inputTokens = readNumber(tokenCount, "inputTokens");
    const outputTokens = readNumber(tokenCount, "outputTokens");
    if (inputTokens !== undefined || outputTokens !== undefined) {
      out.tokenCount = {
        ...(inputTokens !== undefined ? { inputTokens } : {}),
        ...(outputTokens !== undefined ? { outputTokens } : {}),
      };
    }
  }
  const modelInfo = asObject(obj.modelInfo);
  const modelName = modelInfo ? readString(modelInfo, "modelName") : undefined;
  if (modelName !== undefined) out.modelInfo = { modelName };
  // toolFormerData carries the tool name, status, and the raw result body.
  // Export name/status + a MEASURED character count only — the result content
  // itself never leaves the store (size-only by construction).
  const tool = asObject(obj.toolFormerData);
  const toolName = tool ? readString(tool, "name") : undefined;
  if (tool && toolName !== undefined) {
    const status = readString(tool, "status");
    const result = tool.result;
    const resultChars =
      typeof result === "string"
        ? result.length
        : result !== undefined && result !== null
          ? JSON.stringify(result)?.length
          : undefined;
    out.toolCalls = [
      {
        name: toolName,
        ...(status !== undefined ? { status } : {}),
        ...(typeof resultChars === "number" ? { resultChars } : {}),
      },
    ];
  }
  return out;
}

function readNumber(obj: Record<string, unknown>, key: string): number | undefined {
  const v = obj[key];
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

function readString(obj: Record<string, unknown>, key: string): string | undefined {
  const v = obj[key];
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

// Build the export for one composer, or null when it has no messages (an empty
// composer is skipped, not an error — the common case on a fresh install).
function buildComposerExport(
  db: DatabaseSync,
  composerId: string,
  workspaceName: string | undefined,
): CursorComposerExport | null {
  const composer = readComposerValue(db, composerId);
  if (!composer) return null;

  const headersRaw = composer.fullConversationHeadersOnly;
  const headers = Array.isArray(headersRaw)
    ? headersRaw
        .map((h) => asObject(h))
        .filter((h): h is Record<string, unknown> => h !== null)
        .map((h) => ({ bubbleId: readString(h, "bubbleId"), type: readNumber(h, "type") }))
        .filter(
          (h): h is { bubbleId: string; type: number } =>
            typeof h.bubbleId === "string" && typeof h.type === "number",
        )
    : [];
  if (headers.length === 0) return null; // empty composer → honest skip

  const bubbles: Record<string, CursorExportBubble> = {};
  for (const header of headers) {
    const bubble = readBubble(db, composerId, header.bubbleId);
    if (bubble) bubbles[header.bubbleId] = bubble;
  }
  if (Object.keys(bubbles).length === 0) return null; // headers but no bodies → skip

  const modelConfigObj = asObject(composer.modelConfig);
  const modelName = modelConfigObj ? readString(modelConfigObj, "modelName") : undefined;
  const usageData = asObject(composer.usageData);

  const out: CursorComposerExport = {
    composer: {
      composerId,
      fullConversationHeadersOnly: headers,
    },
    bubbles,
  };
  const name = readString(composer, "name");
  if (name !== undefined) out.composer.name = name;
  const ws = workspaceName ?? readString(composer, "workspaceName");
  if (ws !== undefined) out.composer.workspaceName = ws;
  const createdAt = readNumber(composer, "createdAt");
  if (createdAt !== undefined) out.composer.createdAt = createdAt;
  const lastUpdatedAt = readNumber(composer, "lastUpdatedAt");
  if (lastUpdatedAt !== undefined) out.composer.lastUpdatedAt = lastUpdatedAt;
  if (modelName !== undefined) out.composer.modelConfig = { modelName };
  if (usageData && Object.keys(usageData).length > 0) out.composer.usageData = usageData;
  return out;
}

// Derive a friendly workspace name from a workspaceStorage path, when available.
// The global store has none; per-workspace stores live under
// workspaceStorage/<hash>/state.vscdb — the <hash> is opaque, so we leave the
// name to the composer's own workspaceName field (read in buildComposerExport).
function workspaceNameFor(_vscdbPath: string): string | undefined {
  return undefined;
}

// ── public seam: discover + decode ──────────────────────────────────────────────

// Discover one SessionRef per non-empty composer across every vscdb. The ref's
// byteSizeOnDisk/mtimeMs come from the physical file (used only for sort/display);
// identity + content come from the encoded composerId at decode time.
export async function discoverCursorComposers(opts?: HomeOptions): Promise<SessionRef[]> {
  const files = await findVscdbFiles(opts);
  const refs: SessionRef[] = [];
  for (const file of files) {
    const stats = await stat(file).catch(() => null);
    if (!stats?.isFile()) continue;
    const db = openReadOnly(file);
    if (!db) continue;
    try {
      const ws = workspaceNameFor(file);
      for (const composerId of listComposerIds(db)) {
        const exp = buildComposerExport(db, composerId, ws);
        if (!exp) continue; // empty composer → skip
        refs.push({
          sourceKind: "cursor",
          absolutePath: composerRefPath(file, composerId),
          byteSizeOnDisk: stats.size,
          mtimeMs: stats.mtimeMs,
        });
      }
    } finally {
      db.close();
    }
  }
  return refs;
}

// Decode one composer ref back into the single-element records array the
// pipeline anonymizes + uploads: `[{ composer, bubbles }]`. The single object is
// serialized as one NDJSON line and parsed by the cloud adapter as one export.
export async function decodeCursorComposer(ref: SessionRef): Promise<unknown[]> {
  const file = vscdbFilePath(ref.absolutePath);
  const composerId = composerIdOf(ref.absolutePath);
  if (!composerId) return [];
  const db = openReadOnly(file);
  if (!db) return [];
  try {
    const exp = buildComposerExport(db, composerId, workspaceNameFor(file));
    return exp ? [exp] : [];
  } finally {
    db.close();
  }
}
