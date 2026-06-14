import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { withRetry } from "../lib/retry.js";
import { AuthError, StaleResumeError, VersionGateError } from "../lib/errors.js";
import type { Ledger } from "../ledger/ledger.js";
import type { AnonymizationResult } from "../anonymize/index.js";
import type { GitContext } from "./git-context.js";
import { classifyFailure, PresignExpiredError, type FailureReason } from "./failure-reasons.js";
import { CloudPortError, type UploadCloudPort } from "./cloud-port.js";
import type { ProgressReporter } from "./progress.js";
import { ResumeStore, type ManifestEntryState } from "./resume.js";

// The per-entry work the deep module needs. Mirrors the batch-level
// `SessionUploadJob` minus the fields only the manifest creation cares about.
export interface SessionUploadJob {
  sessionId: string;
  identityDerivation: "native" | "path-hash";
  formatVersion: string;
  sourceFilePath: string;
  anonymizationResult: AnonymizationResult;
  rawContentHashAtFirstRun: string;
  // Opt-in (005) git coordinate, attached as manifest metadata only — never part
  // of the payload PUT or of redactedHashHex/contentHash (FR-011, SC-007).
  gitContext?: GitContext;
  // Portable project identity (spec 051): repo name → package name → basename.
  // Resolved independently of `gitContext`/--link-prs; omitted only when "unknown"
  // so the cloud can fall back to its content-derived basename.
  project?: string;
  // Sub-path within the repo's .claude/worktrees/ dir when the session comes
  // from a git worktree (e.g. "001/cloud/ingest/db"). Null for main checkouts.
  worktreePath?: string;
}

export type SkipReason = "missing" | "modified";

// Exactly one terminal outcome per attempt. `attempt()` never throws for a
// per-session failure (it persists + emits + returns "failed"); it rethrows only
// `StaleResumeError`, which aborts the whole batch.
export type SessionOutcome =
  | { kind: "acked"; sessionId: string }
  | { kind: "skipped"; sessionId: string; reason: SkipReason }
  | { kind: "failed"; sessionId: string; reason: FailureReason; message?: string };

export interface SessionUploadDeps {
  cloud: UploadCloudPort;
  resume: ResumeStore;
  reporter: ProgressReporter;
  ledger: Ledger;
  manifestId: string;
  index: number;
  total: number;
}

// Owns the per-entry transition: start → (upload | skip-check) → succeed / fail /
// skip → persist resume entry → emit progress → return outcome. Hides
// `classifyFailure`, every `resume.updateEntry` status/failure write, every
// `reporter.session*` call, NDJSON payload serialization, and the 404/410 →
// `StaleResumeError` mapping. Transport-agnostic: depends only on
// `UploadCloudPort`, never on `../cloud/*`.
export class SessionUpload {
  constructor(private readonly deps: SessionUploadDeps) {}

  // Resume-time pre-check: if the source file vanished or changed since the
  // manifest was created, record the skip (persist + emit) and return the reason
  // so the orchestrator never attempts the upload. Returns null when uploadable.
  async skipIfUnresumable(entry: ManifestEntryState): Promise<SkipReason | null> {
    const verdict = await verifyResumableEntry(entry);
    if (verdict === null) return null;
    this.deps.resume.updateEntry(entry.sessionId, (e) => ({
      ...e,
      status: "skipped-on-resume",
      skippedReason: verdict,
    }));
    this.deps.reporter.sessionSkipped({
      manifestId: this.deps.manifestId,
      sessionId: entry.sessionId,
      reason: verdict,
    });
    return verdict;
  }

  // Run the full attempt for one entry and record exactly one terminal outcome.
  async attempt(entry: ManifestEntryState, job: SessionUploadJob): Promise<SessionOutcome> {
    const { manifestId, resume, reporter, ledger } = this.deps;
    reporter.sessionStart({
      manifestId,
      sessionId: entry.sessionId,
      byteSize: entry.byteSize,
      index: this.deps.index,
      total: this.deps.total,
    });
    resume.updateEntry(entry.sessionId, (e) => ({ ...e, status: "in-flight" }));
    try {
      await this.uploadOne(job);
      const now = new Date().toISOString();
      resume.updateEntry(entry.sessionId, (e) => {
        // A prior attempt may have recorded a failure on this entry; clear it now
        // that the session landed so --report won't show a stale reason.
        const cleaned: ManifestEntryState = { ...e, status: "acked", ackedAt: now };
        delete cleaned.lastFailureReason;
        delete cleaned.lastFailureMessage;
        delete cleaned.failedAt;
        return cleaned;
      });
      ledger.upsertEntry({
        sessionId: entry.sessionId,
        // Prefer this run's freshly-computed deterministic hash over the value
        // stored in resume state: a manifest created by an older binary may hold
        // the salt-dependent redactedHashHex, which would re-trigger a spurious
        // "updated" on the next run.
        contentHash: job.anonymizationResult.contentHashHex,
        lastUploadedAt: now,
        manifestId,
      });
      reporter.sessionAcked({ manifestId, sessionId: entry.sessionId });
      return { kind: "acked", sessionId: entry.sessionId };
    } catch (err) {
      if (err instanceof StaleResumeError) {
        throw err;
      }
      // Auth and version-gate failures are batch-fatal, not per-session: every
      // remaining session would fail identically, and the command-level handler
      // owns their exit codes (10 / 50) and remedies. Reset the entry so the
      // next authenticated run resumes it.
      if (err instanceof AuthError || err instanceof VersionGateError) {
        resume.updateEntry(entry.sessionId, (e) => ({ ...e, status: "pending" }));
        throw err;
      }
      // Isolate the failure: reset to pending so a re-run retries only this
      // session, and persist the classified reason so `frugl upload --report`
      // can explain the cause and remedy.
      const failure = classifyFailure(err);
      resume.updateEntry(entry.sessionId, (e) => ({
        ...e,
        status: "pending",
        lastFailureReason: failure.reason,
        failedAt: new Date().toISOString(),
        ...(failure.message !== undefined ? { lastFailureMessage: failure.message } : {}),
      }));
      reporter.sessionFailed({
        manifestId,
        sessionId: entry.sessionId,
        reason: failure.reason,
        ...(failure.message !== undefined ? { message: failure.message } : {}),
      });
      return {
        kind: "failed",
        sessionId: entry.sessionId,
        reason: failure.reason,
        ...(failure.message !== undefined ? { message: failure.message } : {}),
      };
    }
  }

  // Presign + PUT under a single retry, exactly as the pipeline did: a transient
  // PUT failure re-presigns and retries the whole pair (FR-029a/b). A 404/410 on
  // presign means the manifest is gone — surface it as a batch-aborting
  // StaleResumeError rather than a per-session failure.
  private async uploadOne(job: SessionUploadJob): Promise<void> {
    const body = sessionBodyBytes(job.anonymizationResult.payload);

    await withRetry(async () => {
      let presigned;
      try {
        presigned = await this.deps.cloud.presign(this.deps.manifestId, job.sessionId);
      } catch (err) {
        if (isStaleStatus(err)) throw new StaleResumeError(this.deps.manifestId);
        throw err;
      }
      try {
        await this.deps.cloud.putSessionBody(presigned.url, body, { ...presigned.headers });
      } catch (err) {
        if (isStaleStatus(err)) throw new StaleResumeError(this.deps.manifestId);
        // A 403 from the STORAGE host means the presigned URL expired mid-batch
        // (FR-029a/b). Re-wrap without the status so the surrounding withRetry
        // re-presigns and retries the pair instead of treating it as a
        // non-retryable auth failure.
        if (err instanceof CloudPortError && err.status === 403) {
          throw new PresignExpiredError(`presigned URL rejected: ${err.message}`, { cause: err });
        }
        throw err;
      }
    });
  }
}

// The cloud stores each session as NDJSON (.jsonl) and parses it line by line.
// The anonymized payload is the array of redacted records, so emit one JSON
// document per line. This is THE serialization for both the PUT body and the
// manifest's expected_bytes — they must never diverge.
export function sessionBodyBytes(payload: unknown): Buffer {
  const ndjson = Array.isArray(payload)
    ? payload.map((record) => JSON.stringify(record)).join("\n")
    : JSON.stringify(payload);
  return Buffer.from(ndjson, "utf8");
}

function isStaleStatus(err: unknown): boolean {
  return err instanceof CloudPortError && (err.status === 404 || err.status === 410);
}

export async function rawFileHash(filePath: string): Promise<string> {
  const buf = await readFile(filePath);
  return createHash("sha256").update(buf).digest("hex");
}

async function verifyResumableEntry(entry: ManifestEntryState): Promise<SkipReason | null> {
  try {
    const exists = await stat(entry.sourceFilePath).catch(() => null);
    if (!exists) return "missing";
    const currentHash = await rawFileHash(entry.sourceFilePath);
    if (currentHash !== entry.rawContentHashAtFirstRun) return "modified";
    return null;
  } catch {
    return "missing";
  }
}
