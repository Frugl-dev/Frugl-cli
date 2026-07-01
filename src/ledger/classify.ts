import {
  anonymize,
  contentHash,
  POLICY_VERSION,
  type AnonymizationResult,
} from "../anonymize/index.js";
import type { Ledger, LedgerEntry } from "./ledger.js";
import type { ParsedSession, SessionIdentity, SessionRef, Source } from "../sources/types.js";

export type SessionClassification =
  | {
      kind: "unchanged";
      ref: SessionRef;
      identity: SessionIdentity;
      ledgerEntry: LedgerEntry;
    }
  | {
      kind: "new";
      ref: SessionRef;
      identity: SessionIdentity;
      anonymizationResult: AnonymizationResult;
      parsed: ParsedSession;
    }
  | {
      kind: "updated";
      ref: SessionRef;
      identity: SessionIdentity;
      previousEntry: LedgerEntry;
      anonymizationResult: AnonymizationResult;
      parsed: ParsedSession;
    };

export interface ClassifyAnonymizeOptions {
  uploadId: string;
  ownerEmail: string;
  homeDir?: string;
}

export interface ClassifyContext {
  ledger: Ledger;
  source: Source;
  anonymize: ClassifyAnonymizeOptions;
  // Path-keyed ledger view for the stat fast path. Populated once by
  // classifyAll; when absent (e.g. a direct classifySession call) the fast path
  // is simply skipped and classification falls back to parse + content hash.
  statIndex?: Map<string, LedgerEntry>;
}

export async function classifySession(
  ref: SessionRef,
  ctx: ClassifyContext,
): Promise<SessionClassification> {
  // Fast path: a previously-uploaded file whose path, byte size, and mtime are
  // all unchanged since we recorded them cannot have changed content. Report it
  // unchanged straight from the ledger — no read, no parse, no anonymize walk.
  // Identity is reconstructed from the recorded entry (safe: matching bytes
  // yield the same parse, hence the same identity).
  const byStat = ctx.statIndex?.get(ref.absolutePath);
  if (
    byStat?.derivation !== undefined &&
    byStat.mtimeMs === ref.mtimeMs &&
    byStat.byteSizeOnDisk === ref.byteSizeOnDisk &&
    // A policy bump changes the content hash, so a byte-identical file must be
    // re-anonymized/re-uploaded. Only trust the stat shortcut when the entry was
    // recorded under the policy we're running now.
    byStat.policyVersion === POLICY_VERSION
  ) {
    return {
      kind: "unchanged",
      ref,
      identity: { sessionId: byStat.sessionId, derivation: byStat.derivation },
      ledgerEntry: byStat,
    };
  }

  const parsed = await ctx.source.parse(ref);
  const identity = parsed.identity;
  const existing = ctx.ledger.getEntry(identity.sessionId);
  // Cheap change check: derive the deterministic content hash directly from the
  // parsed records — the exact value anonymize() would compute — WITHOUT running
  // the expensive redaction walk. Unchanged sessions stop here; only genuinely
  // new or updated ones pay for anonymization.
  if (existing && contentHash(parsed.records) === existing.contentHash) {
    return { kind: "unchanged", ref, identity, ledgerEntry: existing };
  }
  const result = anonymize(parsed.records, {
    uploadId: ctx.anonymize.uploadId,
    ownerEmail: ctx.anonymize.ownerEmail,
    ...(ctx.anonymize.homeDir !== undefined ? { homeDir: ctx.anonymize.homeDir } : {}),
  });
  if (!existing) {
    return { kind: "new", ref, identity, anonymizationResult: result, parsed };
  }
  return {
    kind: "updated",
    ref,
    identity,
    previousEntry: existing,
    anonymizationResult: result,
    parsed,
  };
}

// How many sessions to parse + anonymize at once. An unbounded fan-out over a
// large batch (hundreds of sessions) reads every file, decodes it, and runs the
// CPU-bound anonymize walk all at the same time — that exhausts file descriptors
// and memory and pins the event loop, so the redaction progress bar sits at
// 0 / N and the command reads as a hang. A small fixed pool keeps peak work
// bounded and lets progress tick steadily from the first completion.
export const CLASSIFY_CONCURRENCY = 8;

export async function classifyAll(
  refs: SessionRef[],
  ctx: ClassifyContext,
  onProgress?: (done: number, total: number) => void,
  concurrency: number = CLASSIFY_CONCURRENCY,
): Promise<SessionClassification[]> {
  const total = refs.length;
  const all: SessionClassification[] = Array.from({ length: total });
  // Build the path-keyed ledger view once for the whole batch so each session's
  // stat fast path is an O(1) map lookup rather than a full ledger re-scan.
  const cctx: ClassifyContext = { ...ctx, statIndex: ctx.statIndex ?? ctx.ledger.buildStatIndex() };
  let next = 0;
  let done = 0;
  const workers = Math.max(1, Math.min(concurrency, total));
  const worker = async (): Promise<void> => {
    for (let i = next++; i < total; i = next++) {
      all[i] = await classifySession(refs[i]!, cctx);
      done += 1;
      onProgress?.(done, total);
    }
  };
  await Promise.all(Array.from({ length: workers }, () => worker()));
  const seen = new Set<string>();
  const results: SessionClassification[] = [];
  for (const result of all) {
    if (!seen.has(result.identity.sessionId)) {
      seen.add(result.identity.sessionId);
      results.push(result);
    }
  }
  return results;
}

export interface ClassifiedSet {
  unchanged: Extract<SessionClassification, { kind: "unchanged" }>[];
  new: Extract<SessionClassification, { kind: "new" }>[];
  updated: Extract<SessionClassification, { kind: "updated" }>[];
}

export function bucketize(items: SessionClassification[]): ClassifiedSet {
  const buckets: ClassifiedSet = { unchanged: [], new: [], updated: [] };
  for (const item of items) {
    if (item.kind === "unchanged") buckets.unchanged.push(item);
    else if (item.kind === "new") buckets.new.push(item);
    else buckets.updated.push(item);
  }
  return buckets;
}

export function sortByMtimeDesc(items: SessionClassification[]): SessionClassification[] {
  return items.toSorted((a, b) => {
    const dt = b.ref.mtimeMs - a.ref.mtimeMs;
    if (dt !== 0) return dt;
    return a.ref.absolutePath.localeCompare(b.ref.absolutePath);
  });
}
