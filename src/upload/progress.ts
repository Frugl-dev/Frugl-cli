import pc from "picocolors";
import type { OutputMode } from "../lib/output-mode.js";

export type ProgressEvent =
  | {
      event: "upload-start";
      seq: number;
      ts: string;
      manifestId: string;
      expectedSessionCount: number;
      redactionPolicyVersion: string;
      endpoint: string;
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

  return {
    uploadStart(input) {
      const event: ProgressEvent = {
        event: "upload-start",
        seq: seq++,
        ts: ts(),
        ...input,
      };
      if (mode === "json") emitJson(event);
      else
        emitText(
          pc.dim(
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
      if (mode === "json") emitJson(event);
      else
        emitText(
          `[${input.index}/${input.total}] ${input.sessionId} — uploading ${(input.byteSize / 1024).toFixed(1)} KB`,
        );
    },
    sessionAcked(input) {
      const event: ProgressEvent = {
        event: "session-acked",
        seq: seq++,
        ts: ts(),
        manifestId: input.manifestId,
        sessionId: input.sessionId,
      };
      if (mode === "json") emitJson(event);
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
      if (mode === "json") emitJson(event);
      else
        emitText(
          pc.red(
            `! ${input.sessionId} — ${input.reason}${input.message ? `: ${input.message}` : ""}`,
          ),
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
      if (mode === "json") emitJson(event);
      else emitText(pc.yellow(`~ ${input.sessionId} — skipped (${input.reason})`));
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
      if (mode === "json") emitJson(event);
      else
        emitText(
          pc.green(
            `✓ Uploaded ${input.actualSessionCount} sessions. Dashboard: ${input.dashboardUrl}`,
          ),
        );
    },
  };
}
