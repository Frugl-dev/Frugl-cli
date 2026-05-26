import type { ClassifiedSet, SessionClassification } from "../ledger/classify.js";
import type { Endpoint } from "../cloud/endpoints.js";
import { bar, color, formatBytes } from "../lib/theme.js";

export interface PrLinkingSummary {
  active: boolean;
  source: "flag" | "config" | "default";
  sessionsWithContext: number;
  repositories: string[]; // distinct "owner/name", credential-/path-free (FR-015)
}

export interface ProjectSummaryRow {
  providerId: string;
  displayName: string;
  willUpload: number;
}

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
  prLinking?: PrLinkingSummary;
  dateRange?: { from: string; to: string };
  limited?: { active: boolean; limit?: number; candidateCount?: number };
  projects?: ProjectSummaryRow[];
}

export interface BuildSummaryInput {
  buckets: ClassifiedSet;
  willUpload: SessionClassification[];
  policyVersion: string;
  endpoint: Endpoint;
  sourceKind: string;
  prLinking?: PrLinkingSummary;
  limit?: number;
  projects?: ProjectSummaryRow[];
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
    ...(input.prLinking ? { prLinking: input.prLinking } : {}),
    ...(dateRange ? { dateRange } : {}),
    limited,
    ...(input.projects ? { projects: input.projects } : {}),
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

// Width of the label column; values align just past it (mirrors the design).
const LABEL = 18;
const label = (text: string): string => color.mute(text.padEnd(LABEL));

function formatDay(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString("en-US", { month: "short", day: "2-digit" });
}

export function formatSummaryForHuman(s: UploadSummary): string {
  const lines: string[] = [];
  lines.push(
    `${color.bold("Upload preview")}  ${color.dim("— review before sending. Nothing has been transmitted.")}`,
  );
  lines.push("");
  lines.push(
    `  ${label("Endpoint")}${s.endpoint.url}  ${color.dim(`(from ${s.endpoint.resolvedFrom})`)}`,
  );
  lines.push(`  ${label("Source")}${s.sourceKind}`);
  lines.push(
    `  ${label("Discovered")}${color.bold(String(s.discovered))} ${color.dim("sessions")}`,
  );
  lines.push(
    `    ${color.dim("Unchanged".padEnd(LABEL - 2))}${color.dim(`${s.unchanged}   skipping (already uploaded, unmodified)`)}`,
  );
  lines.push(`    ${color.dim("New".padEnd(LABEL - 2))}${color.ok(String(s.new))}`);
  lines.push(`    ${color.dim("Updated".padEnd(LABEL - 2))}${color.warn(String(s.updated))}`);
  lines.push(
    `  ${label("Will upload")}${color.poppyBold(String(s.willUpload))} ${color.dim("sessions")}`,
  );

  if (s.limited?.active) {
    lines.push(
      `  ${label("--limit applied")}${color.dim(`${s.limited.limit} of ${s.limited.candidateCount} candidates`)}`,
    );
  }

  if (s.projects && s.projects.length > 0) {
    lines.push("");
    lines.push(`  ${color.mute("By project")}`);
    const maxCount = Math.max(...s.projects.map((p) => p.willUpload), 1);
    const nameWidth = Math.min(28, Math.max(...s.projects.map((p) => p.displayName.length), 8));
    for (const p of s.projects) {
      const filled = Math.round((p.willUpload / maxCount) * 20);
      lines.push(
        `    ${p.displayName.padEnd(nameWidth)}  ${bar(filled, 20)}  ${color.bold(String(p.willUpload).padStart(3))}`,
      );
    }
  }

  lines.push("");
  lines.push(
    `  ${label("Estimated bytes")}${formatBytes(s.estimatedBytesCompressed)}  ${color.dim("(after local anonymization)")}`,
  );
  const policyBit = `${color.mute("Redaction policy")}   ${color.ok(s.policyVersion)}`;
  const prBit = s.prLinking?.active
    ? `   ${color.dim("PR linking")} ${color.ok("on")}`
    : `   ${color.dim("PR linking off")}`;
  const dateBit = s.dateRange
    ? `   ${color.dim(`Date range  ${formatDay(s.dateRange.from)} → ${formatDay(s.dateRange.to)}`)}`
    : "";
  lines.push(`  ${policyBit}${prBit}${dateBit}`);

  if (s.prLinking?.active) {
    lines.push(
      `    ${color.dim(`Git context  ${s.prLinking.sessionsWithContext} of ${s.willUpload} sessions resolved`)}`,
    );
    if (s.prLinking.repositories.length > 0) {
      lines.push(`    ${color.dim(`Repos        ${s.prLinking.repositories.join(", ")}`)}`);
    }
  }

  return lines.join("\n");
}
