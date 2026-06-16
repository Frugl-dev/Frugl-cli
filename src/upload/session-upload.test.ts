import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { Ledger } from "../ledger/ledger.js";
import { ResumeStore, type ManifestEntryState, type ManifestState } from "./resume.js";
import { SessionUpload, type SessionUploadJob } from "./session-upload.js";
import { InMemoryCloud } from "./in-memory-cloud.js";
import { CloudPortError } from "./cloud-port.js";
import { StaleResumeError, AnonymizationError, AuthError } from "../lib/errors.js";
import type { ProgressReporter } from "./progress.js";
import type { AnonymizationResult } from "../anonymize/index.js";

const MANIFEST_ID = "mfst_session_test";

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

// A reporter that records every call so tests can assert ordering / payloads.
type ReporterCall = { name: keyof ProgressReporter; input: unknown };
function spyReporter(): { reporter: ProgressReporter; calls: ReporterCall[] } {
  const calls: ReporterCall[] = [];
  const reporter: ProgressReporter = {
    uploadStart: (input) => calls.push({ name: "uploadStart", input }),
    sessionStart: (input) => calls.push({ name: "sessionStart", input }),
    sessionAcked: (input) => calls.push({ name: "sessionAcked", input }),
    sessionFailed: (input) => calls.push({ name: "sessionFailed", input }),
    sessionSkipped: (input) => calls.push({ name: "sessionSkipped", input }),
    uploadComplete: (input) => calls.push({ name: "uploadComplete", input }),
  };
  return { reporter, calls };
}

function entryFor(job: SessionUploadJob): ManifestEntryState {
  return {
    sessionId: job.sessionId,
    identityDerivation: "native",
    contentHash: job.anonymizationResult.contentHashHex,
    byteSize: job.anonymizationResult.byteSize,
    sourceFilePath: job.sourceFilePath,
    rawContentHashAtFirstRun: job.rawContentHashAtFirstRun,
    status: "pending",
  };
}

describe("SessionUpload", () => {
  let tempDir: string;
  let stateCwd: string;
  let filesDir: string;
  let resumeStore: ResumeStore;
  let ledger: Ledger;

  const endpoint = "https://test";
  const userId = "user-1";

  function makeJob(sessionId: string, text: string): SessionUploadJob {
    const filePath = path.join(filesDir, `${sessionId}.jsonl`);
    writeFileSync(filePath, text, "utf8");
    return {
      sessionId,
      identityDerivation: "native",
      formatVersion: "claude-jsonl-2026-04",
      sourceFilePath: filePath,
      anonymizationResult: fakeAnonResult(text),
      rawContentHashAtFirstRun: createHash("sha256").update(text).digest("hex"),
    };
  }

  // Seed the resume store with a manifest containing these entries so
  // `updateEntry` has state to mutate.
  function seedResume(entries: ManifestEntryState[]): void {
    const manifest: ManifestState = {
      manifestId: MANIFEST_ID,
      cliVersion: "0.1.0",
      redactionPolicyVersion: "v0.1",
      sourceKind: "claude-code",
      expectedSessionCount: Math.max(1, entries.length),
      endpointUrl: endpoint,
      userId,
      entries,
    };
    resumeStore.save({ schemaVersion: 1, manifest, beganAt: new Date().toISOString() });
  }

  function makeSession(cloud: InMemoryCloud, reporter: ProgressReporter): SessionUpload {
    return new SessionUpload({
      cloud,
      resume: resumeStore,
      reporter,
      ledger,
      manifestId: MANIFEST_ID,
      index: 1,
      total: 1,
    });
  }

  function loadEntry(sessionId: string): ManifestEntryState | undefined {
    return resumeStore.load()?.manifest.entries.find((e) => e.sessionId === sessionId);
  }

  beforeEach(() => {
    tempDir = mkdtempSync(path.join(tmpdir(), "frugl-session-"));
    stateCwd = path.join(tempDir, "state");
    filesDir = path.join(tempDir, "files");
    mkdirSync(stateCwd, { recursive: true });
    mkdirSync(filesDir, { recursive: true });
    resumeStore = new ResumeStore({ endpointUrl: endpoint, userId }, { cwd: stateCwd });
    ledger = new Ledger({ endpointUrl: endpoint, userId }, { cwd: stateCwd });
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("happy path → acked, entry persisted with stale fields cleared, one PUT", async () => {
    const job = makeJob("sess-ok", "record-ok");
    const entry: ManifestEntryState = {
      ...entryFor(job),
      // Pre-existing stale failure from a prior attempt; must be cleared on ack.
      status: "pending",
      lastFailureReason: "network",
      lastFailureMessage: "HTTP 500",
      failedAt: new Date().toISOString(),
    };
    seedResume([entry]);

    const cloud = new InMemoryCloud({ manifestId: MANIFEST_ID });
    const { reporter, calls } = spyReporter();
    const outcome = await makeSession(cloud, reporter).attempt(entry, job);

    expect(outcome).toEqual({ kind: "acked", sessionId: "sess-ok" });
    const persisted = loadEntry("sess-ok")!;
    expect(persisted.status).toBe("acked");
    expect(persisted.ackedAt).toBeTypeOf("string");
    expect(persisted.lastFailureReason).toBeUndefined();
    expect(persisted.lastFailureMessage).toBeUndefined();
    expect(persisted.failedAt).toBeUndefined();

    // Exactly one PUT recorded; ledger updated.
    expect([...cloud.puttedBodies.keys()]).toEqual(["sess-ok"]);
    expect(ledger.getEntry("sess-ok")?.contentHash).toBe(job.anonymizationResult.contentHashHex);

    // sessionStart then sessionAcked emitted, in that order.
    expect(calls.map((c) => c.name)).toEqual(["sessionStart", "sessionAcked"]);
  });

  it("metadata-only tier → acked with NO presign/PUT (spec 054)", async () => {
    const job: SessionUploadJob = { ...makeJob("sess-meta", "record-meta"), tier: "metadata" };
    const entry = entryFor(job);
    seedResume([entry]);

    const cloud = new InMemoryCloud({ manifestId: MANIFEST_ID });
    const { reporter, calls } = spyReporter();
    const outcome = await makeSession(cloud, reporter).attempt(entry, job);

    expect(outcome).toEqual({ kind: "acked", sessionId: "sess-meta" });
    // The defining behavior: no raw body was ever PUT for a metadata session.
    expect([...cloud.puttedBodies.keys()]).toEqual([]);
    expect(loadEntry("sess-meta")?.status).toBe("acked");
    expect(calls.map((c) => c.name)).toEqual(["sessionStart", "sessionAcked"]);
  });

  it("PUT 500 → failed/network, entry reset to pending, emitted, does not throw", async () => {
    const job = makeJob("sess-500", "record-500");
    const entry = entryFor(job);
    seedResume([entry]);

    const cloud = new InMemoryCloud({ manifestId: MANIFEST_ID, failPutWith: 500 });
    const { reporter, calls } = spyReporter();
    const outcome = await makeSession(cloud, reporter).attempt(entry, job);

    expect(outcome).toEqual({
      kind: "failed",
      sessionId: "sess-500",
      reason: "network",
      message: "HTTP 500",
    });
    const persisted = loadEntry("sess-500")!;
    expect(persisted.status).toBe("pending");
    expect(persisted.lastFailureReason).toBe("network");
    expect(persisted.lastFailureMessage).toBe("HTTP 500");
    expect(persisted.failedAt).toBeTypeOf("string");
    expect(cloud.puttedBodies.size).toBe(0);

    const failed = calls.find((c) => c.name === "sessionFailed");
    expect(failed?.input).toMatchObject({ sessionId: "sess-500", reason: "network" });
  });

  it("presign 409 → conflict", async () => {
    const job = makeJob("sess-409", "record-409");
    const entry = entryFor(job);
    seedResume([entry]);

    const cloud = new InMemoryCloud({
      manifestId: MANIFEST_ID,
      failPresign: new Set(["sess-409"]),
      failPresignWith: 409,
    });
    const { reporter } = spyReporter();
    const outcome = await makeSession(cloud, reporter).attempt(entry, job);

    expect(outcome).toMatchObject({ kind: "failed", reason: "conflict" });
    expect(loadEntry("sess-409")?.lastFailureReason).toBe("conflict");
  });

  it("presign 403 (control-plane auth) → rethrows AuthError unretried (batch-abort)", async () => {
    const job = makeJob("sess-403", "record-403");
    const entry = entryFor(job);
    seedResume([entry]);

    const cloud = new InMemoryCloud({
      manifestId: MANIFEST_ID,
      failPresign: new Set(["sess-403"]),
      failPresignWith: 403,
    });
    const { reporter } = spyReporter();
    await expect(makeSession(cloud, reporter).attempt(entry, job)).rejects.toBeInstanceOf(
      AuthError,
    );
    // Not retried (an auth failure repeats identically) and reset to pending
    // so the next authenticated run resumes it.
    expect(cloud.presignedSessions).toEqual(["sess-403"]);
    expect(loadEntry("sess-403")?.status).toBe("pending");
  });

  it("PUT 403 (expired presigned URL) → re-presigns and retries the pair; persistent failure → presign-expired", async () => {
    const job = makeJob("sess-put403", "record-put403");
    const entry = entryFor(job);
    seedResume([entry]);

    const cloud = new InMemoryCloud({ manifestId: MANIFEST_ID, failPutWith: 403 });
    const { reporter } = spyReporter();
    const outcome = await makeSession(cloud, reporter).attempt(entry, job);

    // Each retry of the pair re-presigns: 3 attempts → 3 presigns.
    expect(cloud.presignedSessions).toEqual(["sess-put403", "sess-put403", "sess-put403"]);
    expect(outcome).toMatchObject({ kind: "failed", reason: "presign-expired" });
    expect(loadEntry("sess-put403")?.lastFailureReason).toBe("presign-expired");
  });

  it("thrown SyntaxError → parse", async () => {
    const job = makeJob("sess-parse", "record-parse");
    const entry = entryFor(job);
    seedResume([entry]);

    const cloud = new InMemoryCloud({
      manifestId: MANIFEST_ID,
      presignThrow: () => new SyntaxError("Unexpected token < in JSON"),
    });
    const { reporter } = spyReporter();
    const outcome = await makeSession(cloud, reporter).attempt(entry, job);

    expect(outcome).toMatchObject({ kind: "failed", reason: "parse" });
    expect(loadEntry("sess-parse")?.lastFailureReason).toBe("parse");
  });

  it("AnonymizationError → anonymization", async () => {
    const job = makeJob("sess-anon", "record-anon");
    const entry = entryFor(job);
    seedResume([entry]);

    const cloud = new InMemoryCloud({
      manifestId: MANIFEST_ID,
      presignThrow: () => new AnonymizationError("redaction failed"),
    });
    const { reporter } = spyReporter();
    const outcome = await makeSession(cloud, reporter).attempt(entry, job);

    expect(outcome).toMatchObject({ kind: "failed", reason: "anonymization" });
    expect(loadEntry("sess-anon")?.lastFailureReason).toBe("anonymization");
  });

  it("presign 404 → rethrows StaleResumeError (batch-abort)", async () => {
    const job = makeJob("sess-404", "record-404");
    const entry = entryFor(job);
    seedResume([entry]);

    const cloud = new InMemoryCloud({
      manifestId: MANIFEST_ID,
      presignThrow: () => new CloudPortError("gone", { status: 404 }),
    });
    const { reporter } = spyReporter();
    await expect(makeSession(cloud, reporter).attempt(entry, job)).rejects.toBeInstanceOf(
      StaleResumeError,
    );
  });

  it("presign 410 → rethrows StaleResumeError (batch-abort)", async () => {
    const job = makeJob("sess-410", "record-410");
    const entry = entryFor(job);
    seedResume([entry]);

    const cloud = new InMemoryCloud({
      manifestId: MANIFEST_ID,
      presignThrow: () => new CloudPortError("gone", { status: 410 }),
    });
    const { reporter } = spyReporter();
    await expect(makeSession(cloud, reporter).attempt(entry, job)).rejects.toBeInstanceOf(
      StaleResumeError,
    );
  });

  it("skipIfUnresumable: missing file → 'missing' (skip recorded + emitted)", async () => {
    const job = makeJob("sess-missing", "record-missing");
    const entry = entryFor(job);
    seedResume([entry]);
    unlinkSync(job.sourceFilePath);

    const cloud = new InMemoryCloud({ manifestId: MANIFEST_ID });
    const { reporter, calls } = spyReporter();
    const reason = await makeSession(cloud, reporter).skipIfUnresumable(entry);

    expect(reason).toBe("missing");
    const persisted = loadEntry("sess-missing")!;
    expect(persisted.status).toBe("skipped-on-resume");
    expect(persisted.skippedReason).toBe("missing");
    expect(calls.find((c) => c.name === "sessionSkipped")?.input).toMatchObject({
      sessionId: "sess-missing",
      reason: "missing",
    });
    // No upload attempted.
    expect(cloud.presignedSessions).toHaveLength(0);
  });

  it("skipIfUnresumable: changed file → 'modified'", async () => {
    const job = makeJob("sess-mod", "record-mod");
    const entry = entryFor(job);
    seedResume([entry]);
    writeFileSync(job.sourceFilePath, "different content now", "utf8");

    const cloud = new InMemoryCloud({ manifestId: MANIFEST_ID });
    const { reporter } = spyReporter();
    const reason = await makeSession(cloud, reporter).skipIfUnresumable(entry);

    expect(reason).toBe("modified");
    expect(loadEntry("sess-mod")?.skippedReason).toBe("modified");
  });

  it("skipIfUnresumable: unchanged file → null", async () => {
    const job = makeJob("sess-ok2", "record-ok2");
    const entry = entryFor(job);
    seedResume([entry]);

    const cloud = new InMemoryCloud({ manifestId: MANIFEST_ID });
    const { reporter, calls } = spyReporter();
    const reason = await makeSession(cloud, reporter).skipIfUnresumable(entry);

    expect(reason).toBeNull();
    expect(loadEntry("sess-ok2")?.status).toBe("pending");
    expect(calls).toHaveLength(0);
  });
});
