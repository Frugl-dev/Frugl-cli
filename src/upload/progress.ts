import type { OutputMode } from "../lib/output-mode.js";
import { bar, color, symbol } from "../lib/theme.js";
import { nowIso } from "../lib/time.js";
import { shortSession } from "./upload-output.js";

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

function ts(): string {
  return nowIso();
}

function emitJson(event: ProgressEvent): void {
  process.stdout.write(`${JSON.stringify(event)}\n`);
}

function emitText(line: string): void {
  process.stderr.write(`${line}\n`);
}

export function createProgressReporter(mode: OutputMode): ProgressReporter {
  let seq = 0;

  // Human-mode state: reset per pipeline in uploadStart. JSON mode ignores all of this.
  let total = 0;
  let done = 0;
  let skipped = 0;

  // The live progress bar uses carriage returns to repaint in place — only the
  // default format animates. minimal stays quiet per-session (the final summary
  // still prints) so it never spews `\r` noise into a CI/agent log.
  const liveBar = (): void => {
    if (mode !== "default") return;
    const filled = total > 0 ? Math.round((done / total) * 32) : 0;
    const tail = skipped > 0 ? color.dim(`  ${skipped} skipped`) : "";
    process.stderr.write(`\r\x1b[K  ${bar(filled, 32)}  ${done} / ${total}${tail}`);
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
      done = 0;
      skipped = 0;
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
      liveBar();
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
      process.stderr.write(`\n`);
      emitText(
        `  ${color.err(symbol.cross)} ${color.mute(shortSession(input.sessionId))}  ${color.err("failed")}  ${color.dim(`${input.reason}${input.message ? `: ${input.message}` : ""}`)}`,
      );
      liveBar();
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
      liveBar();
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
      const tail = skipped > 0 ? color.dim(`   ${skipped} skipped`) : "";
      process.stderr.write(`\n`);
      emitText(
        `\n${color.ok(`${symbol.tick} Uploaded ${input.actualSessionCount} sessions.`)}  ${color.dim(`Manifest ${input.manifestId}`)}${tail}`,
      );
      // The human Dashboard line is printed once by the upload command after
      // all per-source pipelines finish, so it can carry the handoff sign-in
      // code (006). The JSON upload-complete event above keeps the plain URL.
    },
  };
}
