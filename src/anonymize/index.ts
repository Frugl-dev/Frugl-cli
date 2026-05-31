import { createHash } from "node:crypto";
import { AnonymizationError } from "../lib/errors.js";
import { POLICY_VERSION, REDACTION_CATEGORIES, type RedactionCategory } from "./policy.js";
import { PseudonymTable } from "./pseudonyms.js";
import { redactClaudePaths } from "./rules/claude-paths.js";
import { redactEmails } from "./rules/emails.js";
import { redactEntropy } from "./rules/entropy.js";
import { redactSecrets } from "./rules/secrets.js";

export { POLICY_VERSION, type RedactionCategory } from "./policy.js";
export { PseudonymTable } from "./pseudonyms.js";

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

function redactString(
  value: string,
  ctx: {
    counts: Record<RedactionCategory, number>;
    pseudonyms: PseudonymTable;
    ownerEmail: string;
    homeDir?: string;
  },
): string {
  let current = value;
  const secrets = redactSecrets(current);
  mergeCounts(ctx.counts, secrets.counts);
  current = secrets.output;
  const paths = redactClaudePaths(current, {
    pseudonyms: ctx.pseudonyms,
    ...(ctx.homeDir !== undefined ? { homeDir: ctx.homeDir } : {}),
  });
  mergeCounts(ctx.counts, paths.counts);
  current = paths.output;
  const emails = redactEmails(current, {
    ownerEmail: ctx.ownerEmail,
    pseudonyms: ctx.pseudonyms,
  });
  mergeCounts(ctx.counts, emails.counts);
  current = emails.output;
  const entropy = redactEntropy(current);
  mergeCounts(ctx.counts, entropy.counts);
  current = entropy.output;
  return current;
}

function walk(value: unknown, ctx: Parameters<typeof redactString>[1]): unknown {
  if (typeof value === "string") return redactString(value, ctx);
  if (Array.isArray(value)) return value.map((item) => walk(item, ctx));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value)) {
      out[key] = walk(val, ctx);
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
  let payload: unknown;
  try {
    payload = walk(input, {
      counts,
      pseudonyms,
      ownerEmail: opts.ownerEmail,
      ...(opts.homeDir !== undefined ? { homeDir: opts.homeDir } : {}),
    });
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
