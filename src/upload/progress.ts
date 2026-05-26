import type { OutputMode } from "../lib/output-mode.js";
import { bar, color, formatBytes, symbol } from "../lib/theme.js";

// Shorten a session id for display: keep head + tail (e.g. sess_5fa1…81d3).
function shortSession(id: string): string {
  return id.length > 16 ? `${id.slice(0, 9)}…${id.slice(-4)}` : id;
}

export type ProgressEvent =
  | {
      event: "upload-start";
      seq: number;
      ts: string;
      manifestId: string;
      expectedSessionCount: number;
      redactionPolicyVersion: string;
      endpoint: string;
      gitContext?: { active: boolean; sessionsWithContext: number; repositories: string[] };
    }
  | {
      event: "session-start";
      seq: number;
      ts: string;
      manifestId: string;
      sessionId: string;
      byteSize: number;
    }
  | {
      event: "session-acked";
      seq: number;
      ts: string;
      manifestId: string;
      sessionId: string;
    }
  | {
      event: "session-failed";
      seq: number;
      ts: string;
      manifestId: string;
      sessionId: string;
      reason: string;
      message?: string;
    }
  | {
      event: "session-skipped";
      seq: number;
      ts: string;
      manifestId: string;
      sessionId: string;
      reason: "missing" | "modified";
    }
  | {
      event: "upload-complete";
      seq: number;
      ts: string;
      manifestId: string;
      actualSessionCount: number;
      dashboardUrl: string;
    };

export interface ProgressReporter {
  uploadStart(input: {
    manifestId: string;
    expectedSessionCount: number;
    redactionPolicyVersion: string;
    endpoint: string;
    gitContext?: { active: boolean; sessionsWithContext: number; repositories: string[] };
  }): void;
  sessionStart(input: {
    manifestId: string;
    sessionId: string;
    byteSize: number;
    index: number;
    total: number;
  }): void;
  sessionAcked(input: { manifestId: string; sessionId: string }): void;
  sessionFailed(input: {
    manifestId: string;
    sessionId: string;
    reason: string;
    message?: string;
  }): void;
  sessionSkipped(input: {
    manifestId: string;
    sessionId: string;
    reason: "missing" | "modified";
  }): void;
  uploadComplete(input: {
    manifestId: string;
    actualSessionCount: number;
    dashboardUrl: string;
  }): void;
}

export function createProgressReporter(mode: OutputMode): ProgressReporter {
  let seq = 0;
  const ts = (): string => new Date().toISOString();
  const emitJson = (event: ProgressEvent): void => {
    process.stdout.write(`${JSON.stringify(event)}\n`);
  };
  const emitText = (line: string): void => {
    process.stderr.write(`${line}\n`);
  };

  // Human-mode state: total comes from upload-start, per-session sizes from
  // session-start; a completed counter drives the "[ n/total]" prefix and the
  // closing progress bar. JSON mode ignores all of this.
  let total = 0;
  let done = 0;
  let skipped = 0;
  const sizeBySession = new Map<string, number>();
  const idxPrefix = (): string => {
    const w = Math.max(2, String(total).length);
    return `[${String(done).padStart(w)}/${total}]`;
  };

  return {
    uploadStart(input) {
      const event: ProgressEvent = {
        event: "upload-start",
        seq: seq++,
        ts: ts(),
        ...input,
      };
      if (mode === "json") return emitJson(event);
      total = input.expectedSessionCount;
      emitText(
        color.dim(
          `Uploading ${input.expectedSessionCount} sessions to ${input.endpoint} (policy ${input.redactionPolicyVersion})`,
        ),
      );
    },
    sessionStart(input) {
      const event: ProgressEvent = {
        event: "session-start",
        seq: seq++,
        ts: ts(),
        manifestId: input.manifestId,
        sessionId: input.sessionId,
        byteSize: input.byteSize,
      };
      if (mode === "json") return emitJson(event);
      total = input.total;
      sizeBySession.set(input.sessionId, input.byteSize);
    },
    sessionAcked(input) {
      const event: ProgressEvent = {
        event: "session-acked",
        seq: seq++,
        ts: ts(),
        manifestId: input.manifestId,
        sessionId: input.sessionId,
      };
      if (mode === "json") return emitJson(event);
      done += 1;
      const size = sizeBySession.get(input.sessionId);
      emitText(
        `${color.ok(idxPrefix())} ${color.mute(shortSession(input.sessionId))}  ${color.ok("uploaded")}   ${color.dim(size !== undefined ? formatBytes(size) : "")}`,
      );
    },
    sessionFailed(input) {
      const event: ProgressEvent = {
        event: "session-failed",
        seq: seq++,
        ts: ts(),
        manifestId: input.manifestId,
        sessionId: input.sessionId,
        reason: input.reason,
        ...(input.message !== undefined ? { message: input.message } : {}),
      };
      if (mode === "json") return emitJson(event);
      done += 1;
      emitText(
        `${color.err(idxPrefix())} ${color.mute(shortSession(input.sessionId))}  ${color.err("failed")}     ${color.dim(`${input.reason}${input.message ? `: ${input.message}` : ""}`)}`,
      );
    },
    sessionSkipped(input) {
      const event: ProgressEvent = {
        event: "session-skipped",
        seq: seq++,
        ts: ts(),
        manifestId: input.manifestId,
        sessionId: input.sessionId,
        reason: input.reason,
      };
      if (mode === "json") return emitJson(event);
      done += 1;
      skipped += 1;
      emitText(
        `${color.warn(`~ ${idxPrefix()}`)} ${color.mute(shortSession(input.sessionId))}  ${color.warn("skipped")}    ${color.dim(`(${input.reason})`)}`,
      );
    },
    uploadComplete(input) {
      const event: ProgressEvent = {
        event: "upload-complete",
        seq: seq++,
        ts: ts(),
        manifestId: input.manifestId,
        actualSessionCount: input.actualSessionCount,
        dashboardUrl: input.dashboardUrl,
      };
      if (mode === "json") return emitJson(event);
      const filled = total > 0 ? Math.round((input.actualSessionCount / total) * 32) : 32;
      const tail = skipped > 0 ? color.dim(`   ${skipped} skipped`) : "";
      emitText(
        `\n  ${bar(filled, 32)}  ${color.bold(String(input.actualSessionCount))} / ${color.bold(String(total))}${tail}`,
      );
      emitText(
        `\n${color.ok(`${symbol.tick} Uploaded ${input.actualSessionCount} sessions.`)}  ${color.dim(`Manifest ${input.manifestId}`)}`,
      );
      emitText(`${color.dim("  Dashboard: ")}${color.poppy(color.underline(input.dashboardUrl))}`);
    },
  };
}
