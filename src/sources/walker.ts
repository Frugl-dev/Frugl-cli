import { access, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { glob } from "tinyglobby";
import type { ProviderDescriptor, ExtractContext } from "./descriptor.js";
import { resolveIdentity } from "./identity.js";
import { parseNdjson } from "./ndjson.js";
import type { ParsedSession, SessionIdentity, SessionRef, Source } from "./types.js";

interface HomeOptions {
  homeDir?: string;
}

function home(opts?: HomeOptions): string {
  return opts?.homeDir ?? homedir();
}

// Returns true if the path exists, false only when it is genuinely absent. Any
// other error (e.g. EACCES) is surfaced rather than swallowed (FR-019).
async function pathExists(target: string): Promise<boolean> {
  try {
    await access(target);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw err;
  }
}

// A provider is "installed" iff its probe path exists under home — unless it
// supplies a custom `probe` (e.g. Cursor's two-source presence check).
export function probe(d: ProviderDescriptor, opts?: HomeOptions): Promise<boolean> {
  if (d.probe) return d.probe(opts?.homeDir !== undefined ? { homeDir: opts.homeDir } : {});
  return pathExists(path.join(home(opts), ...d.layout.probeSegments));
}

// The single filesystem walk: glob → stat → SessionRef. Directories and vanished
// files are skipped; a missing root yields [].
export async function discover(d: ProviderDescriptor, opts?: HomeOptions): Promise<SessionRef[]> {
  // A provider whose store isn't a one-file-per-session glob (Cursor IDE's
  // SQLite vscdb) supplies its own discovery; everything after is shared.
  if (d.discoverRefs) {
    return d.discoverRefs(opts?.homeDir !== undefined ? { homeDir: opts.homeDir } : {});
  }
  const root = path.join(home(opts), ...d.layout.rootSegments);
  const files = await glob(d.layout.globs, { cwd: root, absolute: true, dot: false }).catch(
    () => [],
  );
  const settled = await Promise.all(
    files.map(async (file) => {
      const stats = await stat(file).catch(() => null);
      if (!stats || !stats.isFile()) return null;
      return {
        sourceKind: d.sourceKind,
        absolutePath: path.resolve(file),
        byteSizeOnDisk: stats.size,
        mtimeMs: stats.mtimeMs,
      } as SessionRef;
    }),
  );
  return settled.filter((r): r is SessionRef => r !== null);
}

// The single decode dispatch. NDJSON tolerates malformed lines via `_raw`;
// json-array yields [] for a non-array or malformed file. This is the path that
// unifies gemini with the other providers.
function decode(d: ProviderDescriptor, text: string): unknown[] {
  if (d.format.kind === "ndjson") return parseNdjson(text);
  try {
    const parsed: unknown = JSON.parse(text);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function contextFor(ref: SessionRef, records: unknown[]): ExtractContext {
  return { ref, records, firstRecord: records[0] ?? null };
}

// The single identity/metadata assembly, written once.
export function deriveIdentity(d: ProviderDescriptor, ctx: ExtractContext): SessionIdentity {
  return resolveIdentity({
    ref: ctx.ref,
    nativeId: d.extractNativeId(ctx),
    allowNativeReuse: d.allowNativeReuse ? d.allowNativeReuse(ctx) : true,
  });
}

export async function parse(d: ProviderDescriptor, ref: SessionRef): Promise<ParsedSession> {
  // A provider with a custom decode (Cursor IDE's vscdb) reads its own records;
  // others read the file off disk and run the shared format decode.
  let records = d.decodeRecords
    ? await d.decodeRecords(ref)
    : decode(d, await readFile(ref.absolutePath, "utf8"));
  // Provider metadata records (039) join `records` after the transcript lines,
  // so they pass through anonymization and the content hash like everything
  // else. Collection warnings surface but never abort the parse.
  if (d.collectExtraRecords) {
    const extra = await d.collectExtraRecords(ref);
    for (const warning of extra.warnings) {
      console.warn(`[frugl] ${d.sourceKind}: ${warning}`);
    }
    if (extra.records.length > 0) records = [...records, ...extra.records];
  }
  const ctx = contextFor(ref, records);
  const identity = deriveIdentity(d, ctx);
  const metadata = d.extractMetadata ? d.extractMetadata(ctx) : {};
  return {
    sourceKind: d.sourceKind,
    ref,
    identity,
    records,
    ...(metadata.cwd !== undefined ? { cwd: metadata.cwd } : {}),
    ...(metadata.recordedBranch !== undefined ? { recordedBranch: metadata.recordedBranch } : {}),
  };
}

// Adapts a descriptor to the existing public `Source` interface so every
// downstream consumer (getSourceByKind, the upload pipeline) is unchanged.
export function toSource(d: ProviderDescriptor): Source {
  return {
    kind: d.sourceKind,
    formatVersion: d.formatVersion,
    discover: (opts) => discover(d, opts?.homeDir !== undefined ? { homeDir: opts.homeDir } : {}),
    parse: (ref) => parse(d, ref),
    deriveIdentity: (ref, parsed) => deriveIdentity(d, contextFor(ref, parsed.records)),
  };
}
