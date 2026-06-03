import { createHash } from "node:crypto";
import { AnonymizationError } from "../lib/errors.js";
import { POLICY_VERSION, REDACTION_CATEGORIES, type RedactionCategory } from "./policy.js";
import { PseudonymTable } from "./pseudonyms.js";
import { RULES } from "./rules/registry.js";
import type { RuleContext } from "./rules/types.js";

export { POLICY_VERSION, type RedactionCategory } from "./policy.js";
export { PseudonymTable } from "./pseudonyms.js";
export type { Rule, RuleContext, RuleResult } from "./rules/types.js";

export interface AnonymizeOptions {
  uploadId: string;
  ownerEmail: string;
  policyVersion?: string;
  homeDir?: string;
  pseudonyms?: PseudonymTable;
}

export interface AnonymizationResult {
  payload: unknown;
  redactionsByCategory: Record<RedactionCategory, number>;
  policyVersion: string;
  redactedHashHex: string;
  // Deterministic change-detection hash over the RAW input plus policy version.
  // Unlike redactedHashHex, it does not depend on the per-run uploadId (which
  // salts pseudonyms), so an unchanged session hashes identically across
  // uploads. Used by the ledger to decide unchanged/updated. See classify.ts.
  contentHashHex: string;
  byteSize: number;
}

function emptyCounts(): Record<RedactionCategory, number> {
  const counts: Partial<Record<RedactionCategory, number>> = {};
  for (const category of REDACTION_CATEGORIES) {
    counts[category] = 0;
  }
  return counts as Record<RedactionCategory, number>;
}

function mergeCounts(
  into: Record<RedactionCategory, number>,
  from: Partial<Record<RedactionCategory, number>>,
): void {
  for (const category of REDACTION_CATEGORIES) {
    into[category] += from[category] ?? 0;
  }
}

// Generic apply loop: drive the registry in its declared order, merging every
// rule's counts through the single merge path. Order is RULES order — never
// sorted or filtered here. A rule throwing propagates out of this loop and is
// caught by anonymize()'s fail-closed envelope, aborting the whole payload.
function redactString(
  value: string,
  ctx: RuleContext,
  counts: Record<RedactionCategory, number>,
): string {
  let current = value;
  for (const rule of RULES) {
    const { output, counts: ruleCounts } = rule.apply(current, ctx);
    mergeCounts(counts, ruleCounts);
    current = output;
  }
  return current;
}

function walk(
  value: unknown,
  ctx: RuleContext,
  counts: Record<RedactionCategory, number>,
): unknown {
  if (typeof value === "string") return redactString(value, ctx, counts);
  if (Array.isArray(value)) return value.map((item) => walk(item, ctx, counts));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value)) {
      out[key] = walk(val, ctx, counts);
    }
    return out;
  }
  return value;
}

export function anonymize(input: unknown, opts: AnonymizeOptions): AnonymizationResult {
  if (!opts.uploadId) {
    throw new AnonymizationError("uploadId is required for anonymization");
  }
  if (!opts.ownerEmail) {
    throw new AnonymizationError("ownerEmail is required for anonymization");
  }
  const pseudonyms = opts.pseudonyms ?? new PseudonymTable(opts.uploadId);
  const counts = emptyCounts();
  const ctx: RuleContext = {
    pseudonyms,
    ownerEmail: opts.ownerEmail,
    ...(opts.homeDir !== undefined ? { homeDir: opts.homeDir } : {}),
  };
  let payload: unknown;
  try {
    payload = walk(input, ctx, counts);
  } catch (err) {
    throw new AnonymizationError(
      `Anonymization failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  const serialized = JSON.stringify(payload);
  const hash = createHash("sha256").update(serialized).digest("hex");
  const byteSize = Buffer.byteLength(serialized, "utf8");
  const policyVersion = opts.policyVersion ?? POLICY_VERSION;
  // Hash the raw input (pre-redaction) plus the policy version. This is
  // independent of the per-run uploadId, so identical content yields an
  // identical hash across uploads; a policy bump still forces a re-upload.
  const contentHashHex = createHash("sha256")
    .update(policyVersion)
    .update("\n")
    .update(JSON.stringify(input))
    .digest("hex");
  return {
    payload,
    redactionsByCategory: counts,
    policyVersion,
    redactedHashHex: hash,
    contentHashHex,
    byteSize,
  };
}
