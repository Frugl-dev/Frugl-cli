import { anonymize, type AnonymizationResult } from "../anonymize/index.js";
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
}

export async function classifySession(
  ref: SessionRef,
  ctx: ClassifyContext,
): Promise<SessionClassification> {
  const parsed = await ctx.source.parse(ref);
  const identity = parsed.identity;
  const existing = ctx.ledger.getEntry(identity.sessionId);
  if (!existing) {
    const result = anonymize(parsed.records, {
      uploadId: ctx.anonymize.uploadId,
      ownerEmail: ctx.anonymize.ownerEmail,
      ...(ctx.anonymize.homeDir !== undefined ? { homeDir: ctx.anonymize.homeDir } : {}),
    });
    return { kind: "new", ref, identity, anonymizationResult: result, parsed };
  }
  const result = anonymize(parsed.records, {
    uploadId: ctx.anonymize.uploadId,
    ownerEmail: ctx.anonymize.ownerEmail,
    ...(ctx.anonymize.homeDir !== undefined ? { homeDir: ctx.anonymize.homeDir } : {}),
  });
  if (result.redactedHashHex === existing.contentHash) {
    return { kind: "unchanged", ref, identity, ledgerEntry: existing };
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

export async function classifyAll(
  refs: SessionRef[],
  ctx: ClassifyContext,
): Promise<SessionClassification[]> {
  const results: SessionClassification[] = [];
  const seen = new Set<string>();
  for (const ref of refs) {
    const result = await classifySession(ref, ctx);
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
  return [...items].sort((a, b) => {
    const dt = b.ref.mtimeMs - a.ref.mtimeMs;
    if (dt !== 0) return dt;
    return a.ref.absolutePath.localeCompare(b.ref.absolutePath);
  });
}
