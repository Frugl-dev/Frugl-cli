import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { Ledger } from "../ledger/ledger.js";
import { ResumeStore } from "./resume.js";
import { runUploadPipeline, finalizePendingManifest, type SessionUploadJob } from "./pipeline.js";
import { InMemoryCloud } from "./in-memory-cloud.js";
import { buildReport } from "./upload-output.js";
import type { ProgressReporter } from "./progress.js";
import type { AnonymizationResult } from "../anonymize/index.js";

function noopReporter(): ProgressReporter {
  return {
    uploadStart: () => {},
    sessionStart: () => {},
    sessionAcked: () => {},
    sessionFailed: () => {},
    sessionSkipped: () => {},
    uploadComplete: () => {},
  };
}

function fakeAnonResult(text: string): AnonymizationResult {
  const payload = { text };
  const serialized = JSON.stringify(payload);
  return {
    payload,
    redactionsByCategory: {} as never,
    policyVersion: "v0.1",
    redactedHashHex: createHash("sha256").update(serialized).digest("hex"),
    contentHashHex: createHash("sha256").update(serialized).digest("hex"),
    byteSize: serialized.length,
  };
}

describe("upload pipeline", () => {
  let tempDir: string;
  const endpoint = "https://test";
  const userId = "user-1";

  beforeEach(() => {
    tempDir = mkdtempSync(path.join(tmpdir(), "frugl-pipeline-"));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  function makeJobs(count: number): { jobs: SessionUploadJob[]; sessionIds: string[] } {
    const filesDir = path.join(tempDir, "files");
    mkdirSync(filesDir, { recursive: true });
    const jobs: SessionUploadJob[] = [];
    const sessionIds: string[] = [];
    for (let i = 0; i < count; i++) {
      const sessionId = `sess-${i}`;
      const text = `record-${i}`;
      const filePath = path.join(filesDir, `${sessionId}.jsonl`);
      writeFileSync(filePath, text, "utf8");
      sessionIds.push(sessionId);
      jobs.push({
        sessionId,
        identityDerivation: "native",
        formatVersion: "claude-jsonl-2026-04",
        sourceFilePath: filePath,
        mtimeMs: 0,
        byteSizeOnDisk: text.length,
        anonymizationResult: fakeAnonResult(text),
        rawContentHashAtFirstRun: createHash("sha256").update(text).digest("hex"),
      });
    }
    return { jobs, sessionIds };
  }

  function stores(): { ledger: Ledger; resumeStore: ResumeStore } {
    const stateCwd = path.join(tempDir, "state");
    mkdirSync(stateCwd, { recursive: true });
    return {
      ledger: new Ledger({ endpointUrl: endpoint, userId }, { cwd: stateCwd }),
      resumeStore: new ResumeStore({ endpointUrl: endpoint, userId }, { cwd: stateCwd }),
    };
  }

  it("SC-005: zero duplicate PUTs across interrupted-then-resumed runs", async () => {
    const { ledger, resumeStore } = stores();
    const { jobs, sessionIds } = makeJobs(3);

    // First run: fail the third session's presign so it stays unacked and the
    // batch aborts (failures > 0 throws).
    const failingCloud = new InMemoryCloud({
      manifestId: "mfst_resume_test",
      failPresign: new Set(["sess-2"]),
    });
    let firstRunErrored = false;
    try {
      await runUploadPipeline({
        cloud: failingCloud,
        jobs,
        ledger,
        resumeStore,
        reporter: noopReporter(),
        concurrency: 1,
        policyVersion: "v0.1",
        cliVersion: "0.1.0",
        sourceKind: "claude-code",
        endpointUrl: endpoint,
        userId,
      });
    } catch {
      firstRunErrored = true;
    }
    expect(firstRunErrored).toBe(true);

    // sess-0 and sess-1 were PUT; sess-2 never was.
    const firstPuts = new Set(failingCloud.puttedBodies.keys());
    expect(firstPuts.has("sess-0")).toBe(true);
    expect(firstPuts.has("sess-1")).toBe(true);
    expect(firstPuts.has("sess-2")).toBe(false);

    // Resume run on a fresh cloud: only the unacked session is re-uploaded.
    const resumeCloud = new InMemoryCloud({ manifestId: "mfst_resume_test" });
    await runUploadPipeline({
      cloud: resumeCloud,
      jobs,
      ledger,
      resumeStore,
      reporter: noopReporter(),
      concurrency: 1,
      policyVersion: "v0.1",
      cliVersion: "0.1.0",
      sourceKind: "claude-code",
      endpointUrl: endpoint,
      userId,
    });
    expect([...resumeCloud.puttedBodies.keys()]).toEqual(["sess-2"]);

    // Across both runs each session is PUT exactly once.
    const combined = [...failingCloud.puttedBodies.keys(), ...resumeCloud.puttedBodies.keys()];
    for (const sid of sessionIds) {
      expect(combined.filter((s) => s === sid)).toHaveLength(1);
    }

    // Resume state is cleared on completion (FR-028).
    expect(resumeStore.load()).toBeNull();
  });

  it("persists classified failures and folds them into a --report", async () => {
    const { ledger, resumeStore } = stores();
    const { jobs } = makeJobs(2);

    // sess-1's presign fails with 500 → classified `network`; sess-0 acks.
    const cloud = new InMemoryCloud({
      manifestId: "mfst_report",
      failPresign: new Set(["sess-1"]),
      failPresignWith: 500,
    });
    await runUploadPipeline({
      cloud,
      jobs,
      ledger,
      resumeStore,
      reporter: noopReporter(),
      concurrency: 1,
      policyVersion: "v0.1",
      cliVersion: "0.1.0",
      sourceKind: "claude-code",
      endpointUrl: endpoint,
      userId,
    }).catch(() => {});

    const state = resumeStore.load();
    expect(state).not.toBeNull();
    const failed = state!.manifest.entries.find((e) => e.sessionId === "sess-1");
    expect(failed).toMatchObject({
      status: "pending",
      lastFailureReason: "network",
      lastFailureMessage: "HTTP 500",
    });
    expect(failed!.failedAt).toBeTypeOf("string");

    const acked = state!.manifest.entries.find((e) => e.sessionId === "sess-0");
    expect(acked!.status).toBe("acked");
    expect(acked!.lastFailureReason).toBeUndefined();

    const report = buildReport(state!);
    expect(report.counts).toEqual({ uploaded: 1, failed: 1, skipped: 0, total: 2 });
    expect(report.failures).toHaveLength(1);
    expect(report.failures[0]!.reason).toBe("network");
  });

  it("never wedges on resume state that doesn't cover the batch — starts fresh instead", async () => {
    const { ledger, resumeStore } = stores();
    const { jobs } = makeJobs(2);

    // First run leaves resume state behind (sess-1 fails, batch aborts).
    const failingCloud = new InMemoryCloud({
      manifestId: "mfst_old",
      failPresign: new Set(["sess-1"]),
    });
    await runUploadPipeline({
      cloud: failingCloud,
      jobs,
      ledger,
      resumeStore,
      reporter: noopReporter(),
      concurrency: 1,
      policyVersion: "v0.1",
      cliVersion: "0.1.0",
      sourceKind: "claude-code",
      endpointUrl: endpoint,
      userId,
    }).catch(() => {});
    expect(resumeStore.load()).not.toBeNull();

    // The user kept coding: the next batch contains a session the in-flight
    // manifest has never heard of. This must start a fresh manifest, not throw.
    const filesDir = path.join(tempDir, "files");
    const text = "record-brand-new";
    const filePath = path.join(filesDir, "sess-new.jsonl");
    writeFileSync(filePath, text, "utf8");
    const newJob: SessionUploadJob = {
      sessionId: "sess-new",
      identityDerivation: "native",
      formatVersion: "claude-jsonl-2026-04",
      sourceFilePath: filePath,
      mtimeMs: 0,
      byteSizeOnDisk: text.length,
      anonymizationResult: fakeAnonResult(text),
      rawContentHashAtFirstRun: createHash("sha256").update(text).digest("hex"),
    };

    const freshCloud = new InMemoryCloud({ manifestId: "mfst_fresh" });
    const result = await runUploadPipeline({
      cloud: freshCloud,
      jobs: [...jobs, newJob],
      ledger,
      resumeStore,
      reporter: noopReporter(),
      concurrency: 1,
      policyVersion: "v0.1",
      cliVersion: "0.1.0",
      sourceKind: "claude-code",
      endpointUrl: endpoint,
      userId,
    });
    expect(result.manifestId).toBe("mfst_fresh");
    expect(result.acked.toSorted()).toEqual(["sess-0", "sess-1", "sess-new"]);
    expect(resumeStore.load()).toBeNull();
  });

  it("does not resume a manifest from a different source", async () => {
    const { ledger, resumeStore } = stores();
    const { jobs } = makeJobs(1);

    const failingCloud = new InMemoryCloud({
      manifestId: "mfst_claude",
      failPresign: new Set(["sess-0"]),
    });
    await runUploadPipeline({
      cloud: failingCloud,
      jobs,
      ledger,
      resumeStore,
      reporter: noopReporter(),
      concurrency: 1,
      policyVersion: "v0.1",
      cliVersion: "0.1.0",
      sourceKind: "claude-code",
      endpointUrl: endpoint,
      userId,
    }).catch(() => {});

    // Same session ids would even be "covered", but the source differs —
    // a cursor batch must never adopt a claude-code manifest.
    const cursorCloud = new InMemoryCloud({ manifestId: "mfst_cursor" });
    const result = await runUploadPipeline({
      cloud: cursorCloud,
      jobs,
      ledger,
      resumeStore,
      reporter: noopReporter(),
      concurrency: 1,
      policyVersion: "v0.1",
      cliVersion: "0.1.0",
      sourceKind: "cursor",
      endpointUrl: endpoint,
      userId,
    });
    expect(result.manifestId).toBe("mfst_cursor");
  });

  it("starts fresh when the selection narrowed and a pending entry has no job", async () => {
    const { ledger, resumeStore } = stores();
    const { jobs } = makeJobs(3);

    // Run 1: sess-0 acks, sess-1 and sess-2 fail — resume state holds them pending.
    // 400 is non-retryable, so the failures land instantly (no retry backoff)
    // while still leaving both entries pending in the resume state.
    const failingCloud = new InMemoryCloud({
      manifestId: "mfst_wide",
      failPresign: new Set(["sess-1", "sess-2"]),
      failPresignWith: 400,
    });
    await runUploadPipeline({
      cloud: failingCloud,
      jobs,
      ledger,
      resumeStore,
      reporter: noopReporter(),
      concurrency: 1,
      policyVersion: "v0.1",
      cliVersion: "0.1.0",
      sourceKind: "claude-code",
      endpointUrl: endpoint,
      userId,
    }).catch(() => {});
    expect(resumeStore.load()).not.toBeNull();

    // Run 2 narrows the batch (--limit, a deselected project, a raised
    // --min-cost): only sess-1 is a job. The pending sess-2 entry has no job —
    // resuming would count it as a "missing-job" failure and report the whole
    // batch failed even though sess-1 uploads fine. A fresh manifest covering
    // exactly this batch must be used instead.
    const freshCloud = new InMemoryCloud({ manifestId: "mfst_narrow" });
    const result = await runUploadPipeline({
      cloud: freshCloud,
      jobs: [jobs[1]!],
      ledger,
      resumeStore,
      reporter: noopReporter(),
      concurrency: 1,
      policyVersion: "v0.1",
      cliVersion: "0.1.0",
      sourceKind: "claude-code",
      endpointUrl: endpoint,
      userId,
    });
    expect(result.manifestId).toBe("mfst_narrow");
    expect(result.acked).toEqual(["sess-1"]);
    expect(result.failures).toEqual([]);
    expect(resumeStore.load()).toBeNull();
  });

  it("completes a resumed batch with the originally-declared redaction totals", async () => {
    const { ledger, resumeStore } = stores();
    const { jobs } = makeJobs(2);
    jobs[0]!.anonymizationResult.redactionsByCategory = { email: 3 } as never;
    jobs[1]!.anonymizationResult.redactionsByCategory = { email: 2 } as never;

    // Run 1: sess-0 acks (its 3 redactions are part of the declared batch),
    // sess-1 fails and stays pending.
    const failingCloud = new InMemoryCloud({
      manifestId: "mfst_totals",
      failPresign: new Set(["sess-1"]),
      failPresignWith: 400,
    });
    await runUploadPipeline({
      cloud: failingCloud,
      jobs,
      ledger,
      resumeStore,
      reporter: noopReporter(),
      concurrency: 1,
      policyVersion: "v0.1",
      cliVersion: "0.1.0",
      sourceKind: "claude-code",
      endpointUrl: endpoint,
      userId,
    }).catch(() => {});

    // Run 2 resumes with only the still-pending session — sess-0 classifies as
    // unchanged now and is absent from the batch. The /complete summary must
    // still carry the totals declared for the whole manifest (3 + 2), not a
    // re-aggregate of this run's subset (2).
    const resumeCloud = new InMemoryCloud({ manifestId: "mfst_totals" });
    await runUploadPipeline({
      cloud: resumeCloud,
      jobs: [jobs[1]!],
      ledger,
      resumeStore,
      reporter: noopReporter(),
      concurrency: 1,
      policyVersion: "v0.1",
      cliVersion: "0.1.0",
      sourceKind: "claude-code",
      endpointUrl: endpoint,
      userId,
    });
    expect(resumeCloud.completedSummaries).toEqual([
      { manifestId: "mfst_totals", summary: { email: 5 } },
    ]);
  });

  it("finalizePendingManifest completes an all-acked lingering manifest and clears state", async () => {
    const { ledger, resumeStore } = stores();
    const { jobs } = makeJobs(2);

    // Every session PUTs, then completeManifest dies with a 500 → state lingers
    // with all entries acked and no pending work.
    const dyingCloud = new InMemoryCloud({ manifestId: "mfst_linger", failCompleteWith: 500 });
    await runUploadPipeline({
      cloud: dyingCloud,
      jobs,
      ledger,
      resumeStore,
      reporter: noopReporter(),
      concurrency: 1,
      policyVersion: "v0.1",
      cliVersion: "0.1.0",
      sourceKind: "claude-code",
      endpointUrl: endpoint,
      userId,
    }).catch(() => {});
    const lingering = resumeStore.load();
    expect(lingering).not.toBeNull();
    expect(lingering!.manifest.entries.every((e) => e.status === "acked")).toBe(true);

    const healthyCloud = new InMemoryCloud({ manifestId: "mfst_linger" });
    const finalized = await finalizePendingManifest({ cloud: healthyCloud, resumeStore });
    expect(finalized?.manifestId).toBe("mfst_linger");
    expect(resumeStore.load()).toBeNull();
  });

  it("finalizePendingManifest clears state when the cloud forgot the manifest (410)", async () => {
    const { ledger, resumeStore } = stores();
    const { jobs } = makeJobs(1);
    const dyingCloud = new InMemoryCloud({ manifestId: "mfst_gone", failCompleteWith: 500 });
    await runUploadPipeline({
      cloud: dyingCloud,
      jobs,
      ledger,
      resumeStore,
      reporter: noopReporter(),
      concurrency: 1,
      policyVersion: "v0.1",
      cliVersion: "0.1.0",
      sourceKind: "claude-code",
      endpointUrl: endpoint,
      userId,
    }).catch(() => {});

    const goneCloud = new InMemoryCloud({ manifestId: "mfst_gone", failCompleteWith: 410 });
    const finalized = await finalizePendingManifest({ cloud: goneCloud, resumeStore });
    expect(finalized).toBeNull();
    expect(resumeStore.load()).toBeNull();
  });

  it("finalizePendingManifest keeps state on a still-transient completion failure", async () => {
    const { ledger, resumeStore } = stores();
    const { jobs } = makeJobs(1);
    const dyingCloud = new InMemoryCloud({ manifestId: "mfst_retry", failCompleteWith: 500 });
    await runUploadPipeline({
      cloud: dyingCloud,
      jobs,
      ledger,
      resumeStore,
      reporter: noopReporter(),
      concurrency: 1,
      policyVersion: "v0.1",
      cliVersion: "0.1.0",
      sourceKind: "claude-code",
      endpointUrl: endpoint,
      userId,
    }).catch(() => {});

    const stillDying = new InMemoryCloud({ manifestId: "mfst_retry", failCompleteWith: 500 });
    await expect(finalizePendingManifest({ cloud: stillDying, resumeStore })).rejects.toThrow(
      /HTTP 500/,
    );
    expect(resumeStore.load()).not.toBeNull();
  });

  it("finalizePendingManifest no-ops while resumable work remains", async () => {
    const { ledger, resumeStore } = stores();
    const { jobs } = makeJobs(2);
    const failingCloud = new InMemoryCloud({
      manifestId: "mfst_pending",
      failPresign: new Set(["sess-1"]),
    });
    await runUploadPipeline({
      cloud: failingCloud,
      jobs,
      ledger,
      resumeStore,
      reporter: noopReporter(),
      concurrency: 1,
      policyVersion: "v0.1",
      cliVersion: "0.1.0",
      sourceKind: "claude-code",
      endpointUrl: endpoint,
      userId,
    }).catch(() => {});

    const healthy = new InMemoryCloud({ manifestId: "mfst_pending" });
    const finalized = await finalizePendingManifest({ cloud: healthy, resumeStore });
    expect(finalized).toBeNull();
    expect(resumeStore.load()).not.toBeNull();
  });

  it("uploads correctly under concurrency > 1 (one PUT per session)", async () => {
    const { ledger, resumeStore } = stores();
    const { jobs, sessionIds } = makeJobs(6);
    const cloud = new InMemoryCloud({ manifestId: "mfst_conc" });
    const result = await runUploadPipeline({
      cloud,
      jobs,
      ledger,
      resumeStore,
      reporter: noopReporter(),
      concurrency: 4,
      policyVersion: "v0.1",
      cliVersion: "0.1.0",
      sourceKind: "claude-code",
      endpointUrl: endpoint,
      userId,
    });
    expect(result.acked.toSorted()).toEqual([...sessionIds].toSorted());
    expect([...cloud.puttedBodies.keys()].toSorted()).toEqual([...sessionIds].toSorted());
    expect(resumeStore.load()).toBeNull();
  });

  it("declares expected_bytes matching the NDJSON body actually PUT", async () => {
    const { ledger, resumeStore } = stores();
    const { jobs } = makeJobs(1);
    const cloud = new InMemoryCloud({ manifestId: "mfst_bytes" });
    await runUploadPipeline({
      cloud,
      jobs,
      ledger,
      resumeStore,
      reporter: noopReporter(),
      concurrency: 1,
      policyVersion: "v0.1",
      cliVersion: "0.1.0",
      sourceKind: "claude-code",
      endpointUrl: endpoint,
      userId,
    });
    const declared = cloud.manifests.get("mfst_bytes")!.sessions[0]!.expected_bytes;
    const actual = cloud.puttedBodies.get("sess-0")!.byteLength;
    expect(declared).toBe(actual);
  });

  it("sends the declared MCP inventory on the manifest when provided, omits it otherwise", async () => {
    const { ledger, resumeStore } = stores();
    const { jobs } = makeJobs(1);

    const cloud = new InMemoryCloud({ manifestId: "mfst_mcp" });
    await runUploadPipeline({
      cloud,
      jobs,
      ledger,
      resumeStore,
      reporter: noopReporter(),
      concurrency: 1,
      policyVersion: "v0.1",
      cliVersion: "0.1.0",
      sourceKind: "claude-code",
      endpointUrl: endpoint,
      userId,
      mcpServers: [
        { name: "playwright", status: "connected" },
        { name: "github", status: "failed" },
      ],
    });
    expect(cloud.manifests.get("mfst_mcp")?.mcp_servers).toEqual([
      { name: "playwright", status: "connected" },
      { name: "github", status: "failed" },
    ]);

    // Without the option (e.g. capture failed) the field is absent on the wire.
    const { ledger: ledger2, resumeStore: resume2 } = stores();
    const cloud2 = new InMemoryCloud({ manifestId: "mfst_no_mcp" });
    await runUploadPipeline({
      cloud: cloud2,
      jobs: makeJobs(1).jobs,
      ledger: ledger2,
      resumeStore: resume2,
      reporter: noopReporter(),
      concurrency: 1,
      policyVersion: "v0.1",
      cliVersion: "0.1.0",
      sourceKind: "claude-code",
      endpointUrl: endpoint,
      userId,
    });
    expect(cloud2.manifests.get("mfst_no_mcp")).not.toHaveProperty("mcp_servers");
  });
});
