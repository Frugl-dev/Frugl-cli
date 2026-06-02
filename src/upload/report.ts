import { color, symbol } from "../lib/theme.js";
import { FAILURE_REASON_INFO, type FailureReason } from "./failure-reasons.js";
import type { ManifestEntryState, ResumeState } from "./resume.js";

// `frugl upload --report` — explain a partial upload after the fact: which
// sessions failed, grouped by reason, each with the cause and a one-line remedy.
// Reads the resume store (the in-flight manifest), so it works exactly while
// failed sessions sit pending and resumable. Pure + structured so it renders to
// both human text and `--json`.

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

// Keep head + tail so a session id stays recognizable but short (sess_5fa1…81d3).
export function shortSession(id: string): string {
  return id.length > 16 ? `${id.slice(0, 9)}…${id.slice(-4)}` : id;
}

function isFailed(entry: ManifestEntryState): boolean {
  return entry.lastFailureReason !== undefined && entry.status !== "acked";
}

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

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

// "May 26, 14:08" from an ISO timestamp, rendered in UTC for deterministic output.
export function formatReportDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const mon = MONTHS[d.getUTCMonth()];
  const day = d.getUTCDate();
  const hh = String(d.getUTCHours()).padStart(2, "0");
  const mm = String(d.getUTCMinutes()).padStart(2, "0");
  return `${mon} ${day}, ${hh}:${mm}`;
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
      `  ${color.dim(`${counts.failed} failed session${counts.failed === 1 ? "" : "s"} queued as `)}${color.bold("pending")}${color.dim(". Resume: ")}${color.poppy("frugl upload")}`,
    );
  }

  return lines.join("\n");
}
