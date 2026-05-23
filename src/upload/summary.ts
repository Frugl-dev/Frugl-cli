import type { ClassifiedSet, SessionClassification } from "../ledger/classify.js";
import type { Endpoint } from "../cloud/endpoints.js";

export interface UploadSummary {
  discovered: number;
  unchanged: number;
  new: number;
  updated: number;
  willUpload: number;
  estimatedBytesCompressed: number;
  policyVersion: string;
  endpoint: Endpoint;
  sourceKind: string;
  dateRange?: { from: string; to: string };
  limited?: { active: boolean; limit?: number; candidateCount?: number };
}

export interface BuildSummaryInput {
  buckets: ClassifiedSet;
  willUpload: SessionClassification[];
  policyVersion: string;
  endpoint: Endpoint;
  sourceKind: string;
  limit?: number;
}

export function buildUploadSummary(input: BuildSummaryInput): UploadSummary {
  const discovered =
    input.buckets.unchanged.length + input.buckets.new.length + input.buckets.updated.length;
  const candidateCount = input.buckets.new.length + input.buckets.updated.length;
  const limited =
    input.limit !== undefined
      ? { active: true, limit: input.limit, candidateCount }
      : { active: false };
  let estimated = 0;
  for (const item of input.willUpload) {
    if (item.kind !== "unchanged") {
      estimated += item.anonymizationResult.byteSize;
    }
  }
  const dateRange = computeDateRange(input.willUpload);
  return {
    discovered,
    unchanged: input.buckets.unchanged.length,
    new: input.buckets.new.length,
    updated: input.buckets.updated.length,
    willUpload: input.willUpload.length,
    estimatedBytesCompressed: estimated,
    policyVersion: input.policyVersion,
    endpoint: input.endpoint,
    sourceKind: input.sourceKind,
    ...(dateRange ? { dateRange } : {}),
    limited,
  };
}

function computeDateRange(
  items: SessionClassification[],
): { from: string; to: string } | undefined {
  if (items.length === 0) return undefined;
  let min = Infinity;
  let max = -Infinity;
  for (const item of items) {
    if (item.ref.mtimeMs < min) min = item.ref.mtimeMs;
    if (item.ref.mtimeMs > max) max = item.ref.mtimeMs;
  }
  return {
    from: new Date(min).toISOString(),
    to: new Date(max).toISOString(),
  };
}

export function formatSummaryForHuman(s: UploadSummary): string {
  const lines: string[] = [];
  lines.push(`Endpoint:           ${s.endpoint.url} (from ${s.endpoint.resolvedFrom})`);
  lines.push(`Source:             ${s.sourceKind}`);
  lines.push(`Discovered:         ${s.discovered}`);
  lines.push(`  Unchanged:        ${s.unchanged} (skipping)`);
  lines.push(`  New:              ${s.new}`);
  lines.push(`  Updated:          ${s.updated}`);
  lines.push(`Will upload:        ${s.willUpload}`);
  if (s.limited?.active) {
    lines.push(`  --limit applied:  ${s.limited.limit} of ${s.limited.candidateCount} candidates`);
  }
  lines.push(`Estimated bytes:    ${s.estimatedBytesCompressed}`);
  lines.push(`Redaction policy:   ${s.policyVersion}`);
  if (s.dateRange) {
    lines.push(`Date range:         ${s.dateRange.from}  →  ${s.dateRange.to}`);
  }
  return lines.join("\n");
}
