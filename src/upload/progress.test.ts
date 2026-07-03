import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createProgressReporter, type ProgressEvent } from "./progress.js";

// Capture process.stdout / process.stderr writes so the previously-untested
// progress reporter can be exercised directly (no pipeline, no cloud mock).
function captureStreams(): {
  stdout: () => string;
  stderr: () => string;
  restore: () => void;
} {
  let out = "";
  let err = "";
  const outSpy = vi
    .spyOn(process.stdout, "write")
    .mockImplementation((chunk: string | Uint8Array): boolean => {
      out += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString();
      return true;
    });
  const errSpy = vi
    .spyOn(process.stderr, "write")
    .mockImplementation((chunk: string | Uint8Array): boolean => {
      err += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString();
      return true;
    });
  return {
    stdout: () => out,
    stderr: () => err,
    restore: () => {
      outSpy.mockRestore();
      errSpy.mockRestore();
    },
  };
}

describe("createProgressReporter", () => {
  let streams: ReturnType<typeof captureStreams>;

  beforeEach(() => {
    streams = captureStreams();
  });

  afterEach(() => {
    streams.restore();
  });

  it("text mode: counts acked + skipped across the lifecycle on stderr", () => {
    const reporter = createProgressReporter("default");
    reporter.uploadStart({
      manifestId: "mfst_1",
      expectedSessionCount: 3,
      redactionPolicyVersion: "v0.1",
      endpoint: "https://test",
    });
    for (let i = 0; i < 2; i++) {
      reporter.sessionStart({
        manifestId: "mfst_1",
        sessionId: `sess-${i}`,
        byteSize: 10,
        index: i + 1,
        total: 3,
      });
      reporter.sessionAcked({ manifestId: "mfst_1", sessionId: `sess-${i}` });
    }
    reporter.sessionSkipped({ manifestId: "mfst_1", sessionId: "sess-2", reason: "missing" });
    reporter.uploadComplete({
      manifestId: "mfst_1",
      actualSessionCount: 2,
      dashboardUrl: "https://test/dashboard",
    });

    const err = streams.stderr();
    // Default mode omits the "Uploading N to X" header: the command's preview +
    // confirm prompt already stated it, so the reporter would only repeat it.
    expect(err).not.toContain("Uploading 3 sessions");
    // Live bar reached 3 / 3 (2 acked + 1 skipped) and noted the skip.
    expect(err).toContain("3 / 3");
    expect(err).toContain("1 skipped");
    // Completion line reports the actual count + manifest.
    expect(err).toContain("Uploaded 2 sessions.");
    expect(err).toContain("Manifest mfst_1");
    // The human Dashboard line moved to the upload command so it can carry the
    // handoff sign-in code (006) — the reporter no longer prints the URL.
    expect(err).not.toContain("https://test/dashboard");
    // Text mode never writes machine NDJSON to stdout.
    expect(streams.stdout()).toBe("");
  });

  it("minimal mode: keeps the 'Uploading N to X' header (no preview/prompt precedes it)", () => {
    const reporter = createProgressReporter("minimal");
    reporter.uploadStart({
      manifestId: "mfst_min",
      expectedSessionCount: 3,
      redactionPolicyVersion: "v0.1",
      endpoint: "https://test",
    });

    expect(streams.stderr()).toContain("Uploading 3 sessions to https://test (policy v0.1)");
  });

  it("text mode: a failure increments done and prints the reason", () => {
    const reporter = createProgressReporter("default");
    reporter.uploadStart({
      manifestId: "mfst_2",
      expectedSessionCount: 1,
      redactionPolicyVersion: "v0.1",
      endpoint: "https://test",
    });
    reporter.sessionStart({
      manifestId: "mfst_2",
      sessionId: "sess-x",
      byteSize: 5,
      index: 1,
      total: 1,
    });
    reporter.sessionFailed({
      manifestId: "mfst_2",
      sessionId: "sess-x",
      reason: "network",
      message: "HTTP 500",
    });

    const err = streams.stderr();
    expect(err).toContain("failed");
    expect(err).toContain("network: HTTP 500");
    expect(err).toContain("1 / 1");
  });

  it("json mode: one well-formed event per call with monotonic seq on stdout", () => {
    const reporter = createProgressReporter("json");
    reporter.uploadStart({
      manifestId: "mfst_3",
      expectedSessionCount: 2,
      redactionPolicyVersion: "v0.1",
      endpoint: "https://test",
    });
    reporter.sessionStart({
      manifestId: "mfst_3",
      sessionId: "sess-a",
      byteSize: 7,
      index: 1,
      total: 2,
    });
    reporter.sessionAcked({ manifestId: "mfst_3", sessionId: "sess-a" });
    reporter.sessionFailed({
      manifestId: "mfst_3",
      sessionId: "sess-b",
      reason: "network",
      message: "boom",
    });
    reporter.sessionSkipped({ manifestId: "mfst_3", sessionId: "sess-c", reason: "modified" });
    reporter.uploadComplete({
      manifestId: "mfst_3",
      actualSessionCount: 1,
      dashboardUrl: "https://test/dashboard",
    });

    // JSON mode writes NDJSON to stdout, never to stderr.
    expect(streams.stderr()).toBe("");
    const lines = streams.stdout().trim().split("\n");
    const events = lines.map((l) => JSON.parse(l) as ProgressEvent);

    expect(events.map((e) => e.event)).toEqual([
      "upload-start",
      "session-start",
      "session-acked",
      "session-failed",
      "session-skipped",
      "upload-complete",
    ]);

    // seq is monotonic and starts at 0.
    expect(events.map((e) => e.seq)).toEqual([0, 1, 2, 3, 4, 5]);

    // Each event carries a ts and the contract-required fields.
    for (const e of events) {
      expect(typeof e.ts).toBe("string");
      expect(typeof e.seq).toBe("number");
    }
    const start = events[0] as Extract<ProgressEvent, { event: "upload-start" }>;
    expect(start).toMatchObject({
      manifestId: "mfst_3",
      expectedSessionCount: 2,
      redactionPolicyVersion: "v0.1",
      endpoint: "https://test",
    });
    const failed = events[3] as Extract<ProgressEvent, { event: "session-failed" }>;
    expect(failed).toMatchObject({ sessionId: "sess-b", reason: "network", message: "boom" });
    const complete = events[5] as Extract<ProgressEvent, { event: "upload-complete" }>;
    expect(complete).toMatchObject({
      actualSessionCount: 1,
      dashboardUrl: "https://test/dashboard",
    });
  });

  it("json mode: omits optional message when absent", () => {
    const reporter = createProgressReporter("json");
    reporter.sessionFailed({ manifestId: "m", sessionId: "s", reason: "unknown" });
    const event = JSON.parse(streams.stdout().trim()) as Record<string, unknown>;
    expect(event).not.toHaveProperty("message");
    expect(event.reason).toBe("unknown");
  });
});
