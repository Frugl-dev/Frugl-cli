import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { Ledger } from "../ledger/ledger.js";
import { ResumeStore } from "./resume.js";
import { runUploadPipeline, type SessionUploadJob } from "./pipeline.js";
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
});
