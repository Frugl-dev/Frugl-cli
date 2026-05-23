import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { Ledger } from "../ledger/ledger.js";
import { ResumeStore } from "./resume.js";
import { runUploadPipeline, type SessionUploadJob } from "./pipeline.js";
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
    byteSize: serialized.length,
  };
}

const PRESIGN_PATH_RE = /\/uploads\/[^/]+\/sessions\/([^/]+)\/presign$/;
const PUT_URL_RE = /\/put\/(.+)$/;

interface FakeCallRequest {
  method: string;
  path: string;
  body?: unknown;
  schema: { parse: (v: unknown) => unknown };
}

function makeFakeClient(opts: { manifestId?: string; failOnPresignFor?: Set<string> } = {}): {
  endpointUrl: string;
  cliVersion: string;
  presignCalls: string[];
  putCalls: string[];
  manifestId: string;
  setToken(): void;
  call(req: FakeCallRequest): Promise<unknown>;
  putBody(url: string): Promise<{ ok: true; status: 200; text: () => Promise<string> }>;
} {
  const presignCalls: string[] = [];
  const putCalls: string[] = [];
  const manifestId = opts.manifestId ?? "mfst_test";
  return {
    endpointUrl: "https://test",
    cliVersion: "0.1.0",
    presignCalls,
    putCalls,
    manifestId,
    setToken() {},
    async call(req: FakeCallRequest) {
      if (req.method === "POST" && req.path === "/uploads") {
        return { manifestId };
      }
      if (req.path.endsWith("/complete")) {
        return { manifestId, dashboardUrl: `https://test/dashboards/${manifestId}` };
      }
      const presignMatch = PRESIGN_PATH_RE.exec(req.path);
      if (presignMatch) {
        const sessionId = decodeURIComponent(presignMatch[1]!);
        presignCalls.push(sessionId);
        if (opts.failOnPresignFor?.has(sessionId)) {
          const err = Object.assign(new Error("forced presign failure"), { status: 500 });
          throw err;
        }
        return {
          url: `https://put/${sessionId}`,
          method: "PUT",
          headers: { "Content-Type": "application/octet-stream" },
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
        };
      }
      throw new Error(`Unhandled fake-client call: ${req.method} ${req.path}`);
    },
    async putBody(url: string) {
      const m = PUT_URL_RE.exec(url);
      if (m) putCalls.push(decodeURIComponent(m[1]!));
      return { ok: true as const, status: 200 as const, text: async () => "" };
    },
  };
}

describe("upload pipeline", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(path.join(tmpdir(), "poppi-pipeline-"));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("SC-005: zero duplicate PUTs across interrupted-then-resumed runs", async () => {
    const endpoint = "https://test";
    const userId = "user-1";
    const stateCwd = path.join(tempDir, "state");
    mkdirSync(stateCwd, { recursive: true });
    const ledger = new Ledger({ endpointUrl: endpoint, userId }, { cwd: stateCwd });
    const resumeStore = new ResumeStore({ endpointUrl: endpoint, userId }, { cwd: stateCwd });

    const filesDir = path.join(tempDir, "files");
    mkdirSync(filesDir, { recursive: true });
    const M = 3;
    const sessionIds: string[] = [];
    const jobs: SessionUploadJob[] = [];
    for (let i = 0; i < M; i++) {
      const filePath = path.join(filesDir, `sess-${i}.jsonl`);
      const text = `record-${i}`;
      writeFileSync(filePath, text, "utf8");
      const sessionId = `sess-${i}`;
      sessionIds.push(sessionId);
      const rawHash = createHash("sha256").update(text).digest("hex");
      jobs.push({
        sessionId,
        identityDerivation: "native",
        sourceFilePath: filePath,
        anonymizationResult: fakeAnonResult(text),
        rawContentHashAtFirstRun: rawHash,
      });
    }

    // First run: fail on the third presign to leave session-2 unacked.
    const failingClient = makeFakeClient({
      manifestId: "mfst_resume_test",
      failOnPresignFor: new Set(["sess-2"]),
    });
    let firstRunErrored = false;
    try {
      await runUploadPipeline({
        client: failingClient as never,
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

    const failedSessionPuts = new Set(failingClient.putCalls);
    expect(failedSessionPuts.has("sess-0")).toBe(true);
    expect(failedSessionPuts.has("sess-1")).toBe(true);
    expect(failedSessionPuts.has("sess-2")).toBe(false);

    // Resume run: succeeds for everyone.
    const resumeClient = makeFakeClient({ manifestId: "mfst_resume_test" });
    await runUploadPipeline({
      client: resumeClient as never,
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

    // Resume run should only have issued a PUT for the unacked session.
    expect(resumeClient.putCalls).toEqual(["sess-2"]);

    // Across both runs each sessionId is PUT exactly once.
    const combined = [...failingClient.putCalls, ...resumeClient.putCalls];
    for (const sid of sessionIds) {
      const count = combined.filter((s) => s === sid).length;
      expect(count).toBe(1);
    }

    // Resume state is cleared on completion (FR-028).
    expect(resumeStore.load()).toBeNull();
  });
});
