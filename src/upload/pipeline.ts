import pLimit from "p-limit";
import { NetworkError, FruglError, StaleResumeError } from "../lib/errors.js";
import { EXIT } from "../lib/exit-codes.js";
import type { Ledger } from "../ledger/ledger.js";
import type { ProgressReporter } from "./progress.js";
import type { GitContext } from "./git-context.js";
import { CloudPortError, type UploadCloudPort } from "./cloud-port.js";
import {
  SessionUpload,
  rawFileHash,
  type SessionOutcome,
  type SessionUploadJob,
} from "./session-upload.js";
import { ResumeStore, type ManifestState, type ResumeState } from "./resume.js";

export { rawFileHash };
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
        });

        // On resume, re-check the source file before attempting; a vanished or
        // modified file is skipped, not uploaded.
        if (existing) {
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
    throw new NetworkError(
      `Upload incomplete: ${failures.length} session(s) failed after retries. Re-run 'frugl upload' to resume.`,
    );
  }

  let complete;
  try {
    complete = await opts.cloud.completeManifest(
      manifestState.manifestId,
      aggregateRedactions(opts.jobs),
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
  const { uploadId } = await opts.cloud.createManifest({
    cli_version: opts.cliVersion,
    redaction_policy_version: opts.policyVersion,
    source_kind: opts.sourceKind,
    expected_session_count: opts.jobs.length,
    ...(opts.mcpServers?.length ? { mcp_servers: opts.mcpServers } : {}),
    sessions: opts.jobs.map((job) => ({
      session_id: job.sessionId,
      format_version: job.formatVersion,
      expected_bytes: job.anonymizationResult.byteSize,
      ...(job.gitContext ? { git_context: toWireGitContext(job.gitContext) } : {}),
      ...(job.worktreePath ? { worktree_path: job.worktreePath } : {}),
    })),
  });
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
      throw new FruglError(
        `Resume state references unknown manifest ${state.manifest.manifestId}; session ${job.sessionId} is not part of the in-flight manifest.`,
        EXIT.GENERIC_FAILURE,
      );
    }
  }
  return state.manifest;
}
