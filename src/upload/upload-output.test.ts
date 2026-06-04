import { describe, it, expect } from "vitest";
import {
  buildReport,
  formatReportHuman,
  formatReportDate,
  shortSession,
  buildUploadSummary,
  formatSummaryForHuman,
  shouldLinkPrs,
  type BuildSummaryInput,
} from "./upload-output.js";
import type { ClassifiedSet, SessionClassification } from "../ledger/classify.js";
import type { Endpoint } from "../cloud/endpoints.js";
import type { ManifestEntryState, ResumeState } from "./resume.js";

const ANSI_RE = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g");
const stripAnsi = (s: string): string => s.replace(ANSI_RE, "");

// ---- Report fixtures (ported from report.test.ts) ----

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
      endpointUrl: "https://frugl.dev",
      userId: "user-1",
      entries,
    },
  };
}

// ---- Summary fixtures ----

const ENDPOINT: Endpoint = { url: "https://frugl.dev", resolvedFrom: "default" };

// The summary builder only reads `kind`, `ref.mtimeMs`, and (for non-unchanged)
// `anonymizationResult.byteSize`, so we mint thin fixtures and cast.
function classification(
  kind: "new" | "updated" | "unchanged",
  opts: { mtimeMs: number; byteSize?: number },
): SessionClassification {
  return {
    kind,
    ref: { mtimeMs: opts.mtimeMs },
    ...(kind === "unchanged" ? {} : { anonymizationResult: { byteSize: opts.byteSize ?? 0 } }),
  } as unknown as SessionClassification;
}

function buckets(over: Partial<ClassifiedSet> = {}): ClassifiedSet {
  return {
    unchanged: over.unchanged ?? [],
    new: over.new ?? [],
    updated: over.updated ?? [],
  } as ClassifiedSet;
}

function summaryInput(over: Partial<BuildSummaryInput> = {}): BuildSummaryInput {
  return {
    buckets: buckets(),
    willUpload: [],
    policyVersion: "v0.1",
    endpoint: ENDPOINT,
    sourceKind: "claude-code",
    linkPrs: { flagValue: undefined, configValue: false },
    ...over,
  };
}

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
    expect(out).toContain("1 failed session queued as pending. Resume: frugl upload");
  });

  it("reports a clean state when nothing failed or skipped", () => {
    const report = buildReport(state([entry({ sessionId: "ok-1", status: "acked" })]));
    expect(stripAnsi(formatReportHuman(report))).toContain("No failed sessions");
  });
});

describe("report helpers", () => {
  it("formatReportDate renders UTC month/day/time", () => {
    expect(formatReportDate("2026-05-26T14:08:00.000Z")).toBe("May 26, 14:08");
  });
  it("shortSession keeps head and tail", () => {
    expect(shortSession("sess_5fa1aaaa0000bbbb81d3")).toBe("sess_5fa1…81d3");
    expect(shortSession("short")).toBe("short");
  });
});

describe("buildUploadSummary", () => {
  it("derives discovered/unchanged/new/updated counts from buckets", () => {
    const summary = buildUploadSummary(
      summaryInput({
        buckets: buckets({
          unchanged: [classification("unchanged", { mtimeMs: 1 })] as ClassifiedSet["unchanged"],
          new: [
            classification("new", { mtimeMs: 2, byteSize: 10 }),
            classification("new", { mtimeMs: 3, byteSize: 20 }),
          ] as ClassifiedSet["new"],
          updated: [
            classification("updated", { mtimeMs: 4, byteSize: 5 }),
          ] as ClassifiedSet["updated"],
        }),
      }),
    );
    expect(summary.discovered).toBe(4);
    expect(summary.unchanged).toBe(1);
    expect(summary.new).toBe(2);
    expect(summary.updated).toBe(1);
  });

  it("counts willUpload and sums estimatedBytesCompressed, excluding unchanged", () => {
    const willUpload = [
      classification("new", { mtimeMs: 10, byteSize: 100 }),
      classification("updated", { mtimeMs: 20, byteSize: 50 }),
      classification("unchanged", { mtimeMs: 30 }),
    ];
    const summary = buildUploadSummary(summaryInput({ willUpload }));
    expect(summary.willUpload).toBe(3);
    // unchanged contributes 0 even when present in willUpload
    expect(summary.estimatedBytesCompressed).toBe(150);
  });

  it("computes dateRange min/max from mtimeMs", () => {
    const willUpload = [
      classification("new", { mtimeMs: Date.UTC(2026, 4, 26), byteSize: 1 }),
      classification("new", { mtimeMs: Date.UTC(2026, 4, 20), byteSize: 1 }),
      classification("updated", { mtimeMs: Date.UTC(2026, 4, 30), byteSize: 1 }),
    ];
    const summary = buildUploadSummary(summaryInput({ willUpload }));
    expect(summary.dateRange).toEqual({
      from: new Date(Date.UTC(2026, 4, 20)).toISOString(),
      to: new Date(Date.UTC(2026, 4, 30)).toISOString(),
    });
  });

  it("omits the dateRange key when there are no sessions to upload", () => {
    const summary = buildUploadSummary(summaryInput({ willUpload: [] }));
    expect(summary).not.toHaveProperty("dateRange");
  });

  it("sets limited active with the candidate count when a limit is given", () => {
    const summary = buildUploadSummary(
      summaryInput({
        limit: 2,
        buckets: buckets({
          new: [
            classification("new", { mtimeMs: 1, byteSize: 1 }),
            classification("new", { mtimeMs: 2, byteSize: 1 }),
            classification("new", { mtimeMs: 3, byteSize: 1 }),
          ] as ClassifiedSet["new"],
        }),
      }),
    );
    expect(summary.limited).toEqual({ active: true, limit: 2, candidateCount: 3 });
  });

  it("sets limited inactive when no limit is given", () => {
    const summary = buildUploadSummary(summaryInput());
    expect(summary.limited).toEqual({ active: false });
  });

  it("includes the projects key only when projects are provided", () => {
    const withProjects = buildUploadSummary(
      summaryInput({ projects: [{ providerId: "claude", displayName: "app", willUpload: 2 }] }),
    );
    expect(withProjects.projects).toEqual([
      { providerId: "claude", displayName: "app", willUpload: 2 },
    ]);
    const without = buildUploadSummary(summaryInput());
    expect(without).not.toHaveProperty("projects");
  });
});

describe("link-prs precedence", () => {
  it("flag true → prLinking.source === 'flag' and active", () => {
    const summary = buildUploadSummary(
      summaryInput({
        linkPrs: { flagValue: true, configValue: false },
        gitContext: { sessionsWithContext: 2, repositories: ["a/b"] },
      }),
    );
    expect(summary.prLinking).toEqual({
      active: true,
      source: "flag",
      sessionsWithContext: 2,
      repositories: ["a/b"],
    });
    expect(shouldLinkPrs(true, false)).toBe(true);
  });

  it("flag undefined + config true → prLinking.source === 'config'", () => {
    const summary = buildUploadSummary(
      summaryInput({ linkPrs: { flagValue: undefined, configValue: true } }),
    );
    expect(summary.prLinking).toMatchObject({ active: true, source: "config" });
    // git facts default to empty when the command did not resolve them
    expect(summary.prLinking).toMatchObject({ sessionsWithContext: 0, repositories: [] });
    expect(shouldLinkPrs(undefined, true)).toBe(true);
  });

  it("both off → no prLinking key and shouldLinkPrs === false", () => {
    const summary = buildUploadSummary(
      summaryInput({ linkPrs: { flagValue: undefined, configValue: false } }),
    );
    expect(summary).not.toHaveProperty("prLinking");
    expect(shouldLinkPrs(undefined, false)).toBe(false);
    expect(shouldLinkPrs(false, false)).toBe(false);
  });
});

describe("formatSummaryForHuman", () => {
  it("renders endpoint, will-upload count, project bars, PR-linking block, and --limit", () => {
    const willUpload = [
      classification("new", { mtimeMs: Date.UTC(2026, 4, 26), byteSize: 1024 }),
      classification("updated", { mtimeMs: Date.UTC(2026, 4, 27), byteSize: 1024 }),
    ];
    const summary = buildUploadSummary(
      summaryInput({
        willUpload,
        buckets: buckets({
          new: [willUpload[0]!] as ClassifiedSet["new"],
          updated: [willUpload[1]!] as ClassifiedSet["updated"],
        }),
        limit: 2,
        linkPrs: { flagValue: true, configValue: false },
        gitContext: { sessionsWithContext: 1, repositories: ["acme/web"] },
        projects: [{ providerId: "claude", displayName: "web", willUpload: 2 }],
      }),
    );
    const out = stripAnsi(formatSummaryForHuman(summary));
    expect(out).toContain("Endpoint");
    expect(out).toContain("https://frugl.dev");
    expect(out).toContain("Will upload");
    expect(out).toContain("By project");
    expect(out).toContain("web");
    expect(out).toContain("--limit applied");
    expect(out).toContain("2 of 2 candidates");
    expect(out).toContain("PR linking on");
    expect(out).toContain("Repos        acme/web");
  });

  it("shows PR linking off when linking is inactive", () => {
    const out = stripAnsi(formatSummaryForHuman(buildUploadSummary(summaryInput())));
    expect(out).toContain("PR linking off");
  });
});
