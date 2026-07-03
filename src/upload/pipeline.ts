import pLimit from "p-limit";
import { AnonymizationError, NetworkError, FruglError, StaleResumeError } from "../lib/errors.js";
import { EXIT } from "../lib/exit-codes.js";
import { withRetry } from "../lib/retry.js";
import type { Ledger } from "../ledger/ledger.js";
import type { ProgressReporter } from "./progress.js";
import type { GitContext } from "./git-context.js";
import { CloudPortError, type UploadCloudPort } from "./cloud-port.js";
import {
  SessionUpload,
  rawFileHash,
  createRawFileHasher,
  sessionBodyBytes,
  type SessionOutcome,
  type SessionUploadJob,
} from "./session-upload.js";
import { ResumeStore, type ManifestState, type ResumeState } from "./resume.js";

export { rawFileHash, createRawFileHasher };
export type { SessionUploadJob };

export interface PipelineOptions {
  cloud: UploadCloudPort;
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
  // Declared MCP server inventory (names-only) captured at upload time;
  // omitted when the capture failed or found nothing — never blocks the batch.
  mcpServers?: { name: string; status: "connected" | "failed" | "pending" | "unknown" }[];
}

export interface PipelineResult {
  manifestId: string;
  dashboardUrl: string;
  acked: string[];
  skipped: { sessionId: string; reason: "missing" | "modified" }[];
  failures: { sessionId: string; reason: string }[];
}

// The batch orchestrator: manifest create/reconcile, initial resume save,
// uploadStart/Complete, the pLimit fan-out, folding per-session outcomes, and
// completeManifest + resume clear. The per-entry lifecycle lives in
// `SessionUpload`; this layer never classifies failures or writes entry status.
export async function runUploadPipeline(opts: PipelineOptions): Promise<PipelineResult> {
  if (opts.jobs.length === 0) {
    throw new FruglError("No sessions to upload", EXIT.GENERIC_FAILURE);
  }

  const existing = opts.resumeStore.load();
  const resumed = existing ? reconcileExistingManifest(existing, opts) : null;
  if (existing && !resumed) {
    // The saved manifest doesn't cover this batch (new sessions since the
    // failed run, a narrowed selection that dropped pending entries, a
    // different source, or a different binary). Resuming it is impossible and
    // keeping it would wedge every future upload, so start fresh.
    // Already-acked sessions are protected by the ledger (they classify as
    // unchanged and are not in this batch).
    opts.resumeStore.clear();
  }
  const manifestState = resumed ?? (await createManifest(opts));

  // Batch redaction totals for the /complete summary. On a resumed manifest
  // keep the totals persisted when the batch was first declared: this run's
  // jobs are only the still-pending subset (sessions acked last run classify as
  // unchanged and are absent), so re-aggregating them would undercount.
  const redactionTotals =
    resumed && existing?.redactionTotals
      ? existing.redactionTotals
      : aggregateRedactions(opts.jobs);

  opts.resumeStore.save({
    schemaVersion: 1,
    manifest: manifestState,
    redactionTotals,
    beganAt: resumed && existing ? existing.beganAt : new Date().toISOString(),
  });

  opts.reporter.uploadStart({
    manifestId: manifestState.manifestId,
    expectedSessionCount: manifestState.expectedSessionCount,
    redactionPolicyVersion: opts.policyVersion,
    endpoint: opts.endpointUrl,
    ...(opts.gitContext ? { gitContext: opts.gitContext } : {}),
  });

  const limit = pLimit(Math.max(1, opts.concurrency));
  // One memoizing hasher for the whole batch: resume checks over Cursor entries
  // that share a physical state.vscdb hash it once, not once per session.
  const rawHash = createRawFileHasher();
  const acked: string[] = [];
  const skipped: { sessionId: string; reason: "missing" | "modified" }[] = [];
  const failures: { sessionId: string; reason: string }[] = [];

  const jobsBySessionId = new Map(opts.jobs.map((job) => [job.sessionId, job]));
  const totalCount = manifestState.entries.length;
  let progressIndex = 0;

  const fold = (outcome: SessionOutcome): void => {
    switch (outcome.kind) {
      case "acked":
        acked.push(outcome.sessionId);
        return;
      case "skipped":
        skipped.push({ sessionId: outcome.sessionId, reason: outcome.reason });
        return;
      case "failed":
        failures.push({ sessionId: outcome.sessionId, reason: outcome.reason });
        return;
    }
  };

  await Promise.all(
    manifestState.entries.map((entry) =>
      limit(async () => {
        progressIndex += 1;
        const job = jobsBySessionId.get(entry.sessionId);
        // Already-terminal entries from a prior run fold straight through —
        // never re-uploaded (SC-005), no progress emitted.
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

        const session = new SessionUpload({
          cloud: opts.cloud,
          resume: opts.resumeStore,
          reporter: opts.reporter,
          ledger: opts.ledger,
          manifestId: manifestState.manifestId,
          index: progressIndex,
          total: totalCount,
          rawHash,
        });

        // On resume, re-check the source file before attempting; a vanished or
        // modified file is skipped, not uploaded.
        if (resumed) {
          const skipReason = await session.skipIfUnresumable(entry);
          if (skipReason !== null) {
            skipped.push({ sessionId: entry.sessionId, reason: skipReason });
            return;
          }
        }
        if (!job) {
          failures.push({ sessionId: entry.sessionId, reason: "missing-job" });
          return;
        }
        // `attempt` records the outcome itself (persist + emit); StaleResumeError
        // propagates to abort the whole batch.
        fold(await session.attempt(entry, job));
      }),
    ),
  );

  if (failures.length > 0) {
    const message = `Upload incomplete: ${failures.length} session(s) failed after retries. Re-run 'frugl upload' to resume.`;
    // The exit code should reflect the dominant failure class: a batch where
    // every failure was local redaction (fail-closed, nothing sent) is exit 30,
    // and a batch that failed entirely on local parsing is not a fake "network
    // error" either — only a batch with at least one wire failure is exit 40.
    if (failures.every((f) => f.reason === "anonymization")) {
      throw new AnonymizationError(message);
    }
    if (failures.every((f) => f.reason === "parse" || f.reason === "anonymization")) {
      throw new FruglError(message, EXIT.GENERIC_FAILURE);
    }
    throw new NetworkError(message);
  }

  let complete;
  try {
    // Every session is PUT by this point; a transient blip on /complete must
    // not report the whole batch as failed, so give it the standard retry.
    // Non-retryable statuses (404/410) abort immediately and surface below.
    complete = await withRetry(() =>
      opts.cloud.completeManifest(manifestState.manifestId, redactionTotals),
    );
  } catch (err) {
    if (err instanceof CloudPortError && (err.status === 404 || err.status === 410)) {
      throw new StaleResumeError(manifestState.manifestId);
    }
    throw err;
  }

  opts.resumeStore.clear();
  opts.reporter.uploadComplete({
    manifestId: complete.manifestId,
    actualSessionCount: acked.length,
    dashboardUrl: complete.dashboardUrl,
  });

  return {
    manifestId: complete.manifestId,
    dashboardUrl: complete.dashboardUrl,
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
  // expected_bytes must describe the bytes the cloud will actually receive —
  // the NDJSON PUT body — not the JSON-array serialization byteSize reports.
  const bodyBytes = new Map(
    opts.jobs.map((job) => [
      job.sessionId,
      sessionBodyBytes(job.anonymizationResult.payload).byteLength,
    ]),
  );
  const manifest = await opts.cloud.createManifest({
    cli_version: opts.cliVersion,
    redaction_policy_version: opts.policyVersion,
    source_kind: opts.sourceKind,
    expected_session_count: opts.jobs.length,
    ...(opts.mcpServers?.length ? { mcp_servers: opts.mcpServers } : {}),
    sessions: opts.jobs.map((job) => {
      // spec 054 — a metadata-only job ships its metrics in the manifest and no
      // raw body, so expected_bytes is 0 (nothing is PUT).
      const isMetadata = job.tier === "metadata";
      return {
        session_id: job.sessionId,
        format_version: job.formatVersion,
        expected_bytes: isMetadata ? 0 : bodyBytes.get(job.sessionId)!,
        ...(job.gitContext ? { git_context: toWireGitContext(job.gitContext) } : {}),
        ...(job.worktreePath ? { worktree_path: job.worktreePath } : {}),
        ...(isMetadata && job.metrics ? { tier: "metadata" as const, metrics: job.metrics } : {}),
      };
    }),
  });
  // Session uploads never carry a content_hash, so the snapshot gate's no_change
  // / cap_reached outcomes (spec 052) can't apply here. Anything but `created` is
  // a protocol violation — surface it honestly rather than proceeding blind.
  if (manifest.kind !== "created") {
    throw new FruglError(
      `unexpected manifest outcome for session upload: ${manifest.kind}`,
      EXIT.GENERIC_FAILURE,
    );
  }
  const { uploadId } = manifest;
  return {
    manifestId: uploadId,
    cliVersion: opts.cliVersion,
    redactionPolicyVersion: opts.policyVersion,
    sourceKind: opts.sourceKind,
    expectedSessionCount: opts.jobs.length,
    endpointUrl: opts.endpointUrl,
    userId: opts.userId,
    entries: opts.jobs.map((job) => ({
      sessionId: job.sessionId,
      identityDerivation: job.identityDerivation,
      contentHash: job.anonymizationResult.contentHashHex,
      byteSize: bodyBytes.get(job.sessionId)!,
      sourceFilePath: job.sourceFilePath,
      rawContentHashAtFirstRun: job.rawContentHashAtFirstRun,
      status: "pending",
    })),
  };
}

// Resume the saved manifest only when it actually covers this batch: same
// source, same endpoint+user, every job present in its entries, AND every
// still-attemptable entry backed by a job. Anything else returns null and the
// caller starts a fresh manifest — a mismatch must never be fatal, or one
// failed batch wedges every future upload.
function reconcileExistingManifest(
  state: ResumeState,
  opts: PipelineOptions,
): ManifestState | null {
  const { manifest } = state;
  if (
    manifest.sourceKind !== opts.sourceKind ||
    manifest.endpointUrl !== opts.endpointUrl ||
    manifest.userId !== opts.userId
  ) {
    return null;
  }
  const known = new Set(manifest.entries.map((e) => e.sessionId));
  for (const job of opts.jobs) {
    if (!known.has(job.sessionId)) return null;
  }
  // The reverse direction: a selection narrowed since the failed run (--limit,
  // a deselected project, a raised --min-cost) leaves pending entries with no
  // job. Resuming would count each as a "missing-job" failure and report the
  // whole batch failed even though every attempted session succeeded — so fall
  // back to a fresh manifest instead.
  const jobIds = new Set(opts.jobs.map((j) => j.sessionId));
  for (const entry of manifest.entries) {
    if (
      (entry.status === "pending" || entry.status === "in-flight") &&
      !jobIds.has(entry.sessionId)
    ) {
      return null;
    }
  }
  return manifest;
}

// A previous run PUT every session but died before (or during) completeManifest,
// so the resume state lingers with no pending work. Finish the handshake now:
// complete using the persisted redaction totals, or drop the state if the cloud
// already forgot the manifest. Returns the completion when one happened.
// Throws only on a still-transient completion failure (state is kept).
export async function finalizePendingManifest(opts: {
  cloud: UploadCloudPort;
  resumeStore: ResumeStore;
}): Promise<{ manifestId: string; dashboardUrl: string } | null> {
  const existing = opts.resumeStore.load();
  if (!existing) return null;
  const unfinished = existing.manifest.entries.some(
    (e) => e.status === "pending" || e.status === "in-flight",
  );
  if (unfinished) return null;
  try {
    const complete = await opts.cloud.completeManifest(
      existing.manifest.manifestId,
      existing.redactionTotals ?? {},
    );
    opts.resumeStore.clear();
    return complete;
  } catch (err) {
    if (err instanceof CloudPortError && (err.status === 404 || err.status === 410)) {
      opts.resumeStore.clear();
      return null;
    }
    throw err;
  }
}
