import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import pLimit from "p-limit";
import { CloudClient, CloudHttpError } from "../cloud/client.js";
import {
  createManifestResponseSchema,
  presignResponseSchema,
  completeUploadResponseSchema,
} from "../cloud/schemas.js";
import { withRetry, extractStatus } from "../lib/retry.js";
import { AnonymizationError, NetworkError, PoppiError, StaleResumeError } from "../lib/errors.js";
import { EXIT } from "../lib/exit-codes.js";
import type { AnonymizationResult } from "../anonymize/index.js";
import type { Ledger } from "../ledger/ledger.js";
import type { ProgressReporter } from "./progress.js";
import type { GitContext } from "./git-context.js";
import {
  ResumeStore,
  type ManifestEntryState,
  type ManifestState,
  type ResumeState,
} from "./resume.js";

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
  // Sub-path within the repo's .claude/worktrees/ dir when the session comes
  // from a git worktree (e.g. "001/cloud/ingest/db"). Null for main checkouts.
  worktreePath?: string;
  // Session start time extracted by the source adapter. Sent to the server as a
  // hint so sessions are dated correctly before async NDJSON parsing completes.
  startedAt?: Date;
}

export interface PipelineOptions {
  client: CloudClient;
  jobs: SessionUploadJob[];
  ledger: Ledger;
  resumeStore: ResumeStore;
  reporter: ProgressReporter;
  concurrency: number;
  policyVersion: string;
  cliVersion: string;
  sourceKind: string;
  endpointUrl: string;
  userId: string;
  // Opt-in (005) batch summary for the upload-start event; omitted when off.
  gitContext?: { active: boolean; sessionsWithContext: number; repositories: string[] };
}

export interface PipelineResult {
  manifestId: string;
  dashboardUrl: string;
  acked: string[];
  skipped: { sessionId: string; reason: "missing" | "modified" }[];
  failures: { sessionId: string; reason: string }[];
}

export async function rawFileHash(filePath: string): Promise<string> {
  const buf = await readFile(filePath);
  return createHash("sha256").update(buf).digest("hex");
}

export async function runUploadPipeline(opts: PipelineOptions): Promise<PipelineResult> {
  if (opts.jobs.length === 0) {
    throw new PoppiError("No sessions to upload", EXIT.GENERIC_FAILURE);
  }

  const existing = opts.resumeStore.load();
  const manifestState = existing
    ? reconcileExistingManifest(existing, opts.jobs)
    : await createManifest(opts);

  opts.resumeStore.save({
    schemaVersion: 1,
    manifest: manifestState,
    beganAt: existing?.beganAt ?? new Date().toISOString(),
  });

  opts.reporter.uploadStart({
    manifestId: manifestState.manifestId,
    expectedSessionCount: manifestState.expectedSessionCount,
    redactionPolicyVersion: opts.policyVersion,
    endpoint: opts.endpointUrl,
    ...(opts.gitContext ? { gitContext: opts.gitContext } : {}),
  });

  const limit = pLimit(Math.max(1, opts.concurrency));
  const acked: string[] = [];
  const skipped: { sessionId: string; reason: "missing" | "modified" }[] = [];
  const failures: { sessionId: string; reason: string }[] = [];

  const jobsBySessionId = new Map(opts.jobs.map((job) => [job.sessionId, job]));
  const totalCount = manifestState.entries.length;
  let progressIndex = 0;

  await Promise.all(
    manifestState.entries.map((entry) =>
      limit(async () => {
        progressIndex += 1;
        const job = jobsBySessionId.get(entry.sessionId);
        if (entry.status === "acked") {
          acked.push(entry.sessionId);
          return;
        }
        if (entry.status === "skipped-on-resume") {
          if (entry.skippedReason) {
            skipped.push({ sessionId: entry.sessionId, reason: entry.skippedReason });
          }
          return;
        }
        if (existing) {
          const verdict = await verifyResumableEntry(entry);
          if (verdict !== null) {
            opts.resumeStore.updateEntry(entry.sessionId, (e) => ({
              ...e,
              status: "skipped-on-resume",
              skippedReason: verdict,
            }));
            skipped.push({ sessionId: entry.sessionId, reason: verdict });
            opts.reporter.sessionSkipped({
              manifestId: manifestState.manifestId,
              sessionId: entry.sessionId,
              reason: verdict,
            });
            return;
          }
        }
        if (!job) {
          failures.push({ sessionId: entry.sessionId, reason: "missing-job" });
          return;
        }
        try {
          opts.reporter.sessionStart({
            manifestId: manifestState.manifestId,
            sessionId: entry.sessionId,
            byteSize: entry.byteSize,
            index: progressIndex,
            total: totalCount,
          });
          opts.resumeStore.updateEntry(entry.sessionId, (e) => ({
            ...e,
            status: "in-flight",
          }));
          await uploadOneSession(opts.client, manifestState.manifestId, job);
          const now = new Date().toISOString();
          opts.resumeStore.updateEntry(entry.sessionId, (e) => ({
            ...e,
            status: "acked",
            ackedAt: now,
          }));
          opts.ledger.upsertEntry({
            sessionId: entry.sessionId,
            contentHash: entry.contentHash,
            lastUploadedAt: now,
            manifestId: manifestState.manifestId,
          });
          opts.reporter.sessionAcked({
            manifestId: manifestState.manifestId,
            sessionId: entry.sessionId,
          });
          acked.push(entry.sessionId);
        } catch (err) {
          if (err instanceof StaleResumeError) {
            throw err;
          }
          const reason = describeFailure(err);
          opts.resumeStore.updateEntry(entry.sessionId, (e) => ({ ...e, status: "pending" }));
          opts.reporter.sessionFailed({
            manifestId: manifestState.manifestId,
            sessionId: entry.sessionId,
            reason: reason.category,
            ...(reason.message !== undefined ? { message: reason.message } : {}),
          });
          failures.push({ sessionId: entry.sessionId, reason: reason.category });
        }
      }),
    ),
  );

  if (failures.length > 0) {
    throw new NetworkError(
      `Upload incomplete: ${failures.length} session(s) failed after retries. Re-run 'poppi upload' to resume.`,
    );
  }

  let complete;
  try {
    complete = await opts.client.call({
      method: "POST",
      path: `/api/uploads/${encodeURIComponent(manifestState.manifestId)}/complete`,
      body: {
        redaction_summary: aggregateRedactions(opts.jobs),
      },
      schema: completeUploadResponseSchema,
    });
  } catch (err) {
    if (err instanceof CloudHttpError && (err.status === 404 || err.status === 410)) {
      throw new StaleResumeError(manifestState.manifestId);
    }
    throw err;
  }

  opts.resumeStore.clear();
  opts.reporter.uploadComplete({
    manifestId: complete.manifest_id,
    actualSessionCount: acked.length,
    dashboardUrl: complete.dashboard_url,
  });

  return {
    manifestId: complete.manifest_id,
    dashboardUrl: complete.dashboard_url,
    acked,
    skipped,
    failures,
  };
}

// The cloud's /complete contract takes a flat { category: count } map of all
// redactions applied across the batch (every value a non-negative integer).
function aggregateRedactions(jobs: SessionUploadJob[]): Record<string, number> {
  const totals: Record<string, number> = {};
  for (const job of jobs) {
    for (const [category, count] of Object.entries(job.anonymizationResult.redactionsByCategory)) {
      totals[category] = (totals[category] ?? 0) + count;
    }
  }
  return totals;
}

function toWireGitContext(ctx: GitContext): {
  repository: { host: string; owner: string; name: string };
  branch?: string;
  commit_sha: string;
} {
  return {
    repository: ctx.repository,
    ...(ctx.branch !== undefined ? { branch: ctx.branch } : {}),
    commit_sha: ctx.commitSha,
  };
}

async function createManifest(opts: PipelineOptions): Promise<ManifestState> {
  let created;
  try {
    created = await opts.client.call({
      method: "POST",
      path: "/api/uploads/manifest",
      body: {
        cli_version: opts.cliVersion,
        redaction_policy_version: opts.policyVersion,
        source_kind: opts.sourceKind,
        expected_session_count: opts.jobs.length,
        sessions: opts.jobs.map((job) => ({
          session_id: job.sessionId,
          format_version: job.formatVersion,
          expected_bytes: job.anonymizationResult.byteSize,
          ...(job.gitContext ? { git_context: toWireGitContext(job.gitContext) } : {}),
          ...(job.worktreePath ? { worktree_path: job.worktreePath } : {}),
          ...(job.startedAt !== undefined ? { started_at_ms: job.startedAt.getTime() } : {}),
        })),
      },
      schema: createManifestResponseSchema,
      timeoutMs: 12_000,
    });
  } catch (err) {
    if (
      err instanceof CloudHttpError &&
      err.status === 409 &&
      typeof err.body === "object" &&
      err.body !== null &&
      (err.body as Record<string, unknown>).error === "org_required"
    ) {
      throw new PoppiError(
        "Your account has no organization. Run 'poppi setup' to finish setup.",
        EXIT.GENERIC_FAILURE,
      );
    }
    throw err;
  }
  return {
    manifestId: created.upload_id,
    cliVersion: opts.cliVersion,
    redactionPolicyVersion: opts.policyVersion,
    sourceKind: opts.sourceKind,
    expectedSessionCount: opts.jobs.length,
    endpointUrl: opts.endpointUrl,
    userId: opts.userId,
    entries: opts.jobs.map((job) => ({
      sessionId: job.sessionId,
      identityDerivation: job.identityDerivation,
      contentHash: job.anonymizationResult.redactedHashHex,
      byteSize: job.anonymizationResult.byteSize,
      sourceFilePath: job.sourceFilePath,
      rawContentHashAtFirstRun: job.rawContentHashAtFirstRun,
      status: "pending",
    })),
  };
}

function reconcileExistingManifest(state: ResumeState, jobs: SessionUploadJob[]): ManifestState {
  const known = new Set(state.manifest.entries.map((e) => e.sessionId));
  for (const job of jobs) {
    if (!known.has(job.sessionId)) {
      throw new PoppiError(
        `Resume state references unknown manifest ${state.manifest.manifestId}; session ${job.sessionId} is not part of the in-flight manifest.`,
        EXIT.GENERIC_FAILURE,
      );
    }
  }
  return state.manifest;
}

async function verifyResumableEntry(
  entry: ManifestEntryState,
): Promise<"missing" | "modified" | null> {
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

async function uploadOneSession(
  client: CloudClient,
  manifestId: string,
  job: SessionUploadJob,
): Promise<void> {
  // The cloud stores each session as NDJSON (`.jsonl`) and parses it line by
  // line. The anonymized payload is the array of redacted records, so emit one
  // JSON document per line rather than a single gzipped blob.
  const payload = job.anonymizationResult.payload;
  const ndjson = Array.isArray(payload)
    ? payload.map((record) => JSON.stringify(record)).join("\n")
    : JSON.stringify(payload);
  const body = Buffer.from(ndjson, "utf8");

  await withRetry(async () => {
    let presigned;
    try {
      presigned = await client.call({
        method: "POST",
        path: `/api/uploads/${encodeURIComponent(manifestId)}/presign`,
        body: { session_id: job.sessionId },
        schema: presignResponseSchema,
      });
    } catch (err) {
      if (err instanceof CloudHttpError && (err.status === 404 || err.status === 410)) {
        throw new StaleResumeError(manifestId);
      }
      throw err;
    }
    const response = await client.putBody(presigned.presigned_url, body, { ...presigned.headers });
    if (!response.ok) {
      const status = response.status;
      const err: CloudHttpError = new CloudHttpError(
        status,
        await response.text().catch(() => ""),
        `PUT presigned URL failed: HTTP ${status}`,
      );
      throw err;
    }
  });
}

function describeFailure(err: unknown): { category: string; message?: string } {
  if (err instanceof AnonymizationError) return { category: "anonymization", message: err.message };
  if (err instanceof NetworkError) return { category: "network", message: err.message };
  const status = extractStatus(err);
  if (status === 403) return { category: "presign-expired", message: `HTTP ${status}` };
  if (status) return { category: "network", message: `HTTP ${status}` };
  if (err instanceof Error) return { category: "network", message: err.message };
  return { category: "unknown" };
}
