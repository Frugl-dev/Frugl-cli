import { Temporal } from "temporal-polyfill";
import type { ClassifiedSet, SessionClassification } from "../ledger/classify.js";
import type { Endpoint } from "../cloud/endpoints.js";
import { bar, color, formatBytes, symbol } from "../lib/theme.js";
import { FAILURE_REASON_INFO, type FailureReason } from "./failure-reasons.js";
import type { ManifestEntryState, ResumeState } from "./resume.js";

// All presentation/aggregation for the `upload` command lives here: classification
// buckets + resume state become the two contract JSON objects (UploadSummary,
// UploadReport), which the human formatters then render. Builders are the ONLY
// producers of contract JSON; formatters take an already-built contract object and
// return a string — so human and `--json` output can never diverge (FR-036).

// ---- Contract JSON shapes (FROZEN — FR-036). Emitted verbatim into --json. ----

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
  // The full-upload threshold in USD (spec 054): sessions at/above it upload
  // their raw transcript; cheaper ones (down to the $0.01 floor) upload metadata
  // only. `metadataOnly` is how many of `willUpload` are metadata-tier;
  // `excludedEmpty` is how many candidates were dropped as empty (< $0.01).
  // Surfaced so a thin upload reads as deliberate tiering, not a bug.
  minCost?: number;
  metadataOnly?: number;
  excludedEmpty?: number;
}

export interface ReportFailureSession {
  sessionId: string;
  shortId: string;
  message?: string;
}

export interface ReportFailureGroup {
  reason: FailureReason;
  summary: string;
  remedy: string;
  sessions: ReportFailureSession[];
}

export interface ReportSkippedSession {
  sessionId: string;
  shortId: string;
  reason: "missing" | "modified";
}

export interface UploadReport {
  manifestId: string;
  beganAt: string;
  counts: { uploaded: number; failed: number; skipped: number; total: number };
  failures: ReportFailureGroup[];
  skipped: ReportSkippedSession[];
}

// ---- Link-prs precedence (private) ----

interface EffectiveLinkPrs {
  active: boolean;
  source: "flag" | "config" | "default";
}

// Precedence (R-7): an explicit `--link-prs` flag wins, else the persisted
// `linkPrs` config, else off. `flagValue` is `undefined` when the flag was not
// passed (the oclif flag has no default), `true` when passed.
function resolveEffectiveLinkPrs(
  flagValue: boolean | undefined,
  configValue: boolean,
): EffectiveLinkPrs {
  if (flagValue === true) return { active: true, source: "flag" };
  if (configValue === true) return { active: true, source: "config" };
  return { active: false, source: "default" };
}

// Lets the command skip the expensive git-context pass without re-implementing
// precedence: returns whether PR linking is active for the given flag/config.
export function shouldLinkPrs(flagValue: boolean | undefined, configValue: boolean): boolean {
  return resolveEffectiveLinkPrs(flagValue, configValue).active;
}

// ---- Data builders: the ONLY producers of contract JSON. Pure. ----

export interface BuildSummaryInput {
  buckets: ClassifiedSet;
  willUpload: SessionClassification[];
  policyVersion: string;
  endpoint: Endpoint;
  sourceKind: string;
  // link-prs precedence folded IN: callers pass raw inputs, not a resolved object.
  linkPrs: { flagValue: boolean | undefined; configValue: boolean };
  // git-context facts the command resolved (only consulted when linking is active):
  gitContext?: { sessionsWithContext: number; repositories: string[] };
  limit?: number;
  projects?: ProjectSummaryRow[];
  // The full-upload threshold (USD) plus the tiering counts the command computed
  // (metadata-only uploads, and candidates excluded as empty). The builder just
  // carries them onto the contract.
  minCost?: number;
  metadataOnly?: number;
  excludedEmpty?: number;
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

  // PR-linking summary is assembled here (not in the command): precedence is
  // resolved, and `prLinking` is set only when linking is active.
  const effective = resolveEffectiveLinkPrs(input.linkPrs.flagValue, input.linkPrs.configValue);
  const prLinking: PrLinkingSummary | undefined = effective.active
    ? {
        active: true,
        source: effective.source,
        sessionsWithContext: input.gitContext?.sessionsWithContext ?? 0,
        repositories: input.gitContext?.repositories ?? [],
      }
    : undefined;

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
    ...(prLinking ? { prLinking } : {}),
    ...(dateRange ? { dateRange } : {}),
    limited,
    ...(input.projects ? { projects: input.projects } : {}),
    ...(input.minCost !== undefined ? { minCost: input.minCost } : {}),
    ...(input.metadataOnly !== undefined ? { metadataOnly: input.metadataOnly } : {}),
    ...(input.excludedEmpty !== undefined ? { excludedEmpty: input.excludedEmpty } : {}),
  };
}

// The classification sub-object every upload result variant (dry-run, noop,
// final) embeds — built here so the three emitters can't drift apart.
export function buildClassification(s: UploadSummary): {
  discovered: number;
  unchanged: number;
  new: number;
  updated: number;
} {
  return { discovered: s.discovered, unchanged: s.unchanged, new: s.new, updated: s.updated };
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
  // `mtimeMs` carries sub-millisecond fractional digits from the filesystem;
  // `fromEpochMilliseconds` demands an integer (unlike `new Date`, which
  // truncated silently), so floor to whole milliseconds first.
  return {
    from: Temporal.Instant.fromEpochMilliseconds(Math.trunc(min)).toString({
      smallestUnit: "millisecond",
    }),
    to: Temporal.Instant.fromEpochMilliseconds(Math.trunc(max)).toString({
      smallestUnit: "millisecond",
    }),
  };
}

// Keep head + tail so a session id stays recognizable but short (sess_5fa1…81d3).
export function shortSession(id: string): string {
  return id.length > 16 ? `${id.slice(0, 9)}…${id.slice(-4)}` : id;
}

function isFailed(entry: ManifestEntryState): boolean {
  return entry.lastFailureReason !== undefined && entry.status !== "acked";
}

// `frugl upload --report` — explain a partial upload after the fact: which
// sessions failed, grouped by reason, each with the cause and a one-line remedy.
// Reads the resume store (the in-flight manifest), so it works exactly while
// failed sessions sit pending and resumable.
export function buildReport(state: ResumeState): UploadReport {
  const entries = state.manifest.entries;
  const uploaded = entries.filter((e) => e.status === "acked").length;
  const skippedEntries = entries.filter(
    (e) => e.skippedReason !== undefined && e.status !== "acked",
  );
  const failedEntries = entries.filter(isFailed);

  const byReason = new Map<FailureReason, ReportFailureSession[]>();
  for (const e of failedEntries) {
    const reason = e.lastFailureReason as FailureReason;
    const list = byReason.get(reason) ?? [];
    list.push({
      sessionId: e.sessionId,
      shortId: shortSession(e.sessionId),
      ...(e.lastFailureMessage !== undefined ? { message: e.lastFailureMessage } : {}),
    });
    byReason.set(reason, list);
  }

  const failures: ReportFailureGroup[] = [...byReason.entries()]
    .map(([reason, sessions]) => {
      const info = FAILURE_REASON_INFO[reason];
      return {
        reason,
        summary: info.summary,
        remedy: info.remedy.replace(
          "{id}",
          sessions[0]?.shortId.split("…")[0] ?? sessions[0]?.shortId ?? "",
        ),
        sessions,
      };
    })
    .toSorted((a, b) => FAILURE_REASON_INFO[a.reason].order - FAILURE_REASON_INFO[b.reason].order);

  return {
    manifestId: state.manifest.manifestId,
    beganAt: state.beganAt,
    counts: {
      uploaded,
      failed: failedEntries.length,
      skipped: skippedEntries.length,
      total: state.manifest.expectedSessionCount,
    },
    failures,
    skipped: skippedEntries.map((e) => ({
      sessionId: e.sessionId,
      shortId: shortSession(e.sessionId),
      reason: e.skippedReason as "missing" | "modified",
    })),
  };
}

// ---- Human formatters: pure functions of already-built contract data. ----

// Width of the label column; values align just past it (mirrors the design).
const LABEL = 18;
const label = (text: string): string => color.mute(text.padEnd(LABEL));

function formatDay(iso: string): string {
  try {
    // Local time zone (no `timeZone` option), matching the prior
    // `new Date(iso).toLocaleDateString(...)` behavior.
    return Temporal.Instant.from(iso).toLocaleString("en-US", { month: "short", day: "2-digit" });
  } catch {
    return iso;
  }
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
  if (s.excludedEmpty !== undefined && s.excludedEmpty > 0) {
    lines.push(
      `    ${color.dim("Excluded (empty)".padEnd(LABEL - 2))}${color.dim(`${s.excludedEmpty}   skipping (under $0.01)`)}`,
    );
  }
  lines.push(
    `  ${label("Will upload")}${color.frogBold(String(s.willUpload))} ${color.dim("sessions")}`,
  );
  if (s.metadataOnly !== undefined && s.metadataOnly > 0) {
    // No dollar amount here — the `Min cost` line right below owns the threshold,
    // so repeating "(under $X)" on both lines is redundant.
    lines.push(
      `    ${color.dim("Metadata only".padEnd(LABEL - 2))}${color.dim(`${s.metadataOnly}   metrics, no transcript`)}`,
    );
  }
  if (s.minCost !== undefined) {
    lines.push(
      `  ${label("Min cost")}${color.dim(`$${s.minCost.toFixed(2)} — cheaper sessions upload metadata only`)}`,
    );
  }

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
  let dateBit = "";
  if (s.dateRange) {
    const from = formatDay(s.dateRange.from);
    const to = formatDay(s.dateRange.to);
    // Collapse to a single day when the whole batch lands on one date — an arrow
    // range with identical ends ("Jul 03 → Jul 03") reads as a bug.
    dateBit =
      from === to
        ? `   ${color.dim(`Date  ${from}`)}`
        : `   ${color.dim(`Date range  ${from} → ${to}`)}`;
  }
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

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

// "May 26, 14:08" from an ISO timestamp, rendered in UTC for deterministic output.
export function formatReportDate(iso: string): string {
  let z: Temporal.ZonedDateTime;
  try {
    z = Temporal.Instant.from(iso).toZonedDateTimeISO("UTC");
  } catch {
    return iso;
  }
  const mon = MONTHS[z.month - 1]; // Temporal months are 1-indexed.
  const hh = String(z.hour).padStart(2, "0");
  const mm = String(z.minute).padStart(2, "0");
  return `${mon} ${z.day}, ${hh}:${mm}`;
}

export function formatReportHuman(report: UploadReport): string {
  const { counts } = report;
  const lines: string[] = [];

  lines.push(
    `${color.bold("Upload report")}  ${color.mute(report.manifestId)}   ${color.dim(formatReportDate(report.beganAt))}`,
  );
  lines.push("");
  lines.push(
    `  ${color.ok(`${counts.uploaded} uploaded`)}   ${color.err(`${counts.failed} failed`)}   ${color.warn(`${counts.skipped} skipped`)}   ${color.dim(`of ${counts.total}`)}`,
  );
  lines.push("");

  if (counts.failed === 0 && counts.skipped === 0) {
    lines.push(`  ${color.ok(`${symbol.tick} No failed sessions — nothing to report.`)}`);
    return lines.join("\n");
  }

  for (const group of report.failures) {
    const n = group.sessions.length;
    lines.push(
      `  ${color.err(`${symbol.cross} ${group.reason}`)}   ${color.dim(`${n} session${n === 1 ? "" : "s"}   ${group.summary}`)}`,
    );
    for (const s of group.sessions) {
      const detail = s.message ? `   ${color.dim(s.message)}` : "";
      lines.push(`      ${color.mute(s.shortId)}${detail}`);
    }
    lines.push(`      ${color.mute("→")} ${color.dim(group.remedy)}`);
    lines.push("");
  }

  if (report.skipped.length > 0) {
    const n = report.skipped.length;
    lines.push(
      `  ${color.warn(`~ skipped`)}   ${color.dim(`${n} session${n === 1 ? "" : "s"}   file went missing / changed mid-upload — not an error`)}`,
    );
    for (const s of report.skipped) {
      lines.push(
        `      ${color.mute(s.shortId)}   ${color.dim("picked up automatically next run")}`,
      );
    }
    lines.push("");
  }

  if (counts.failed > 0) {
    lines.push(
      `  ${color.dim(`${counts.failed} failed session${counts.failed === 1 ? "" : "s"} queued as `)}${color.bold("pending")}${color.dim(". Resume: ")}${color.frog("frugl upload")}`,
    );
  }

  return lines.join("\n");
}
