import { describe, it, expect } from "vitest";
import { buildReport, formatReportHuman, formatReportDate, shortSession } from "./report.js";
import type { ManifestEntryState, ResumeState } from "./resume.js";

const HASH = "a".repeat(64);

function entry(over: Partial<ManifestEntryState>): ManifestEntryState {
  return {
    sessionId: "sess-default",
    identityDerivation: "native",
    contentHash: HASH,
    byteSize: 100,
    sourceFilePath: "/tmp/x.jsonl",
    rawContentHashAtFirstRun: HASH,
    status: "pending",
    ...over,
  };
}

function state(entries: ManifestEntryState[]): ResumeState {
  return {
    schemaVersion: 1,
    beganAt: "2026-05-26T14:08:00.000Z",
    manifest: {
      manifestId: "man_8f2b7a91",
      cliVersion: "1.0.0",
      redactionPolicyVersion: "v0.1",
      sourceKind: "claude-code",
      expectedSessionCount: entries.length,
      endpointUrl: "https://poppi.dev",
      userId: "user-1",
      entries,
    },
  };
}

const ANSI_RE = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g");
const stripAnsi = (s: string): string => s.replace(ANSI_RE, "");

describe("buildReport", () => {
  it("counts uploaded / failed / skipped and groups failures by reason in order", () => {
    const report = buildReport(
      state([
        entry({ sessionId: "ok-1", status: "acked" }),
        entry({ sessionId: "ok-2", status: "acked" }),
        entry({
          sessionId: "conf-1",
          status: "pending",
          lastFailureReason: "conflict",
          lastFailureMessage: "HTTP 409",
        }),
        entry({
          sessionId: "parse-1",
          status: "pending",
          lastFailureReason: "parse",
          lastFailureMessage: "unexpected token at line 4128",
        }),
        entry({ sessionId: "skip-1", status: "skipped-on-resume", skippedReason: "modified" }),
      ]),
    );

    expect(report.counts).toEqual({ uploaded: 2, failed: 2, skipped: 1, total: 5 });
    // parse (order 0) before conflict (order 1)
    expect(report.failures.map((g) => g.reason)).toEqual(["parse", "conflict"]);
    expect(report.failures[0]!.sessions[0]).toMatchObject({
      sessionId: "parse-1",
      message: "unexpected token at line 4128",
    });
    expect(report.skipped).toEqual([
      { sessionId: "skip-1", shortId: "skip-1", reason: "modified" },
    ]);
  });

  it("does not count an acked entry that previously failed", () => {
    const report = buildReport(
      state([
        entry({
          sessionId: "retried",
          status: "acked",
          lastFailureReason: "presign-expired",
          lastFailureMessage: "HTTP 403",
        }),
      ]),
    );
    expect(report.counts.failed).toBe(0);
    expect(report.counts.uploaded).toBe(1);
    expect(report.failures).toHaveLength(0);
  });
});

describe("formatReportHuman", () => {
  it("renders the header, grouped failures with remedies, and the resume hint", () => {
    const report = buildReport(
      state([
        entry({ sessionId: "ok-1", status: "acked" }),
        entry({
          sessionId: "conf-1",
          status: "pending",
          lastFailureReason: "conflict",
          lastFailureMessage: "HTTP 409",
        }),
      ]),
    );
    const out = stripAnsi(formatReportHuman(report));
    expect(out).toContain("Upload report  man_8f2b7a91   May 26, 14:08");
    expect(out).toContain("1 uploaded   1 failed   0 skipped   of 2");
    expect(out).toContain("✗ conflict   1 session   already uploaded (HTTP 409)");
    expect(out).toContain("→ Safe to ignore");
    expect(out).toContain("1 failed session queued as pending. Resume: poppi upload");
  });

  it("reports a clean state when nothing failed or skipped", () => {
    const report = buildReport(state([entry({ sessionId: "ok-1", status: "acked" })]));
    expect(stripAnsi(formatReportHuman(report))).toContain("No failed sessions");
  });
});

describe("helpers", () => {
  it("formatReportDate renders UTC month/day/time", () => {
    expect(formatReportDate("2026-05-26T14:08:00.000Z")).toBe("May 26, 14:08");
  });
  it("shortSession keeps head and tail", () => {
    expect(shortSession("sess_5fa1aaaa0000bbbb81d3")).toBe("sess_5fa1…81d3");
    expect(shortSession("short")).toBe("short");
  });
});
