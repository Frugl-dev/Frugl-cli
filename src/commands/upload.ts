import { Command, Flags } from "@oclif/core";
import { confirm } from "@inquirer/prompts";
import { mkdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import pc from "picocolors";
import { randomUUID } from "node:crypto";
import { CloudClient } from "../cloud/client.js";
import { resolveEndpoint } from "../cloud/endpoints.js";
import { requireAuthSession } from "../auth/session.js";
import {
  classifyAll,
  bucketize,
  sortByMtimeDesc,
  type SessionClassification,
} from "../ledger/classify.js";
import { Ledger } from "../ledger/ledger.js";
import { ResumeStore } from "../upload/resume.js";
import {
  buildUploadSummary,
  formatSummaryForHuman,
  type PrLinkingSummary,
} from "../upload/summary.js";
import { createProgressReporter } from "../upload/progress.js";
import { runUploadPipeline, rawFileHash, type SessionUploadJob } from "../upload/pipeline.js";
import { resolveGitContext, type GitContext } from "../upload/git-context.js";
import { resolveEffectiveLinkPrs, type EffectiveLinkPrs } from "../upload/link-prs.js";
import { claudeCodeSource, CLAUDE_FORMAT_VERSION } from "../sources/claude-code/index.js";
import { POLICY_VERSION } from "../anonymize/index.js";
import {
  InspectDirError,
  isPoppiError,
  NoSessionsError,
  StaleResumeError,
  UsageError,
} from "../lib/errors.js";
import { EXIT } from "../lib/exit-codes.js";
import { getCliVersion } from "../lib/cli-version.js";
import { getLinkPrs } from "../lib/config.js";
import { resolveOutputMode } from "../lib/output-mode.js";

export default class Upload extends Command {
  static override description =
    "Discover local AI-coding session sources, anonymize them, and batch-upload to hosted Poppi.";

  static override flags = {
    confirm: Flags.boolean({ description: "Skip the interactive confirmation prompt." }),
    yes: Flags.boolean({ description: "Alias for --confirm" }),
    "dry-run": Flags.boolean({ description: "Anonymize but do not transmit." }),
    inspect: Flags.string({
      description: "With --dry-run: write redacted output to a local inspection dir.",
    }),
    force: Flags.boolean({ description: "Overwrite existing --inspect dir." }),
    endpoint: Flags.string({ description: "Override the API endpoint." }),
    concurrency: Flags.integer({
      description: "Per-session upload concurrency (default 4).",
      default: 4,
    }),
    limit: Flags.integer({
      description: "Maximum number of (new ∪ updated) sessions to upload.",
    }),
    "link-prs": Flags.boolean({
      // No default: undefined = not passed (fall back to persisted config); true = passed.
      description:
        "Opt in to attaching credential-stripped git context (repo, branch, commit) so sessions can be linked to PRs. Default off.",
    }),
    json: Flags.boolean({ description: "Emit machine-readable JSON output", default: false }),
  };

  async run(): Promise<void> {
    const { flags } = await this.parse(Upload);
    const mode = resolveOutputMode({ json: flags.json });
    const reporter = createProgressReporter(mode);
    // Resolved opt-in: explicit flag wins, else persisted config, else off (R-7).
    // When inactive, the git-context resolver is never entered (FR-002/SC-001).
    const linkPrs = resolveEffectiveLinkPrs(flags["link-prs"], getLinkPrs());

    if (flags.inspect && !flags["dry-run"]) {
      this.bail(new UsageError("--inspect requires --dry-run."));
    }
    if (flags.limit !== undefined && flags.limit <= 0) {
      this.bail(new UsageError("--limit must be a positive integer."));
    }

    const endpoint = resolveEndpoint({
      flag: flags.endpoint,
      env: process.env["POPPI_ENDPOINT"],
    });
    if (mode === "text") {
      process.stderr.write(pc.dim(`Endpoint: ${endpoint.url} (from ${endpoint.resolvedFrom})\n`));
    }

    try {
      const session = await requireAuthSession(endpoint.url);
      const client = new CloudClient({
        endpointUrl: endpoint.url,
        cliVersion: getCliVersion(),
        token: session.token,
        endpointExplicit: endpoint.resolvedFrom !== "default",
      });

      const refs = await claudeCodeSource.discover(
        process.env["POPPI_HOME_DIR"] ? { homeDir: process.env["POPPI_HOME_DIR"] } : undefined,
      );
      if (refs.length === 0) {
        throw new NoSessionsError(
          `No sessions found under ~/.claude/projects/ (source: ${claudeCodeSource.kind}). Make sure Claude Code has been used on this machine.`,
        );
      }

      const ledger = new Ledger({ endpointUrl: endpoint.url, userId: session.userId });
      const resumeStore = new ResumeStore({ endpointUrl: endpoint.url, userId: session.userId });

      const uploadId = randomUUID();
      const sortedRefs = refs.sort(
        (a, b) => b.mtimeMs - a.mtimeMs || a.absolutePath.localeCompare(b.absolutePath),
      );

      const classifications = await classifyAll(sortedRefs, {
        ledger,
        source: claudeCodeSource,
        anonymize: {
          uploadId,
          ownerEmail: session.email,
        },
      });
      const buckets = bucketize(classifications);

      const candidates: SessionClassification[] = sortByMtimeDesc([
        ...buckets.new,
        ...buckets.updated,
      ]);
      const willUpload = flags.limit !== undefined ? candidates.slice(0, flags.limit) : candidates;

      // Opt-in git-context resolution over the willUpload batch ONLY (after
      // --limit). Hard-gated: when inactive, the resolver is never entered, no
      // cwd/.git is read, and no git field is attached or emitted (FR-002/SC-001).
      const gitBySession = new Map<string, GitContext>();
      let prLinking: PrLinkingSummary | undefined;
      if (linkPrs.active) {
        const repositories = await this.resolveBatchGitContext(willUpload, gitBySession, linkPrs);
        prLinking = {
          active: true,
          source: linkPrs.source,
          sessionsWithContext: gitBySession.size,
          repositories,
        };
      }

      const summary = buildUploadSummary({
        buckets,
        willUpload,
        policyVersion: POLICY_VERSION,
        endpoint,
        sourceKind: claudeCodeSource.kind,
        ...(prLinking ? { prLinking } : {}),
        ...(flags.limit !== undefined ? { limit: flags.limit } : {}),
      });

      if (mode === "text") {
        process.stdout.write(`${formatSummaryForHuman(summary)}\n`);
      }

      if (flags["dry-run"]) {
        if (flags.inspect) {
          await writeInspectionDir(flags.inspect, !!flags.force, willUpload, summary, gitBySession);
        }
        const result = {
          command: "upload" as const,
          ok: true as const,
          manifestId: "dry-run",
          actualSessionCount: 0,
          expectedSessionCount: Math.max(1, willUpload.length),
          redactionPolicyVersion: POLICY_VERSION,
          sourceKind: claudeCodeSource.kind,
          endpoint: endpoint.url,
          dashboardUrl: `${endpoint.url}/dry-run`,
          classification: {
            discovered: summary.discovered,
            unchanged: summary.unchanged,
            new: summary.new,
            updated: summary.updated,
          },
          limited: summary.limited ?? { active: false },
          ...(prLinking
            ? {
                gitContext: {
                  active: true,
                  sessionsWithContext: prLinking.sessionsWithContext,
                  repositories: prLinking.repositories,
                },
              }
            : {}),
          dryRun: true,
        };
        process.stdout.write(`${JSON.stringify(result)}\n`);
        return;
      }

      if (willUpload.length === 0) {
        const result = {
          command: "upload" as const,
          ok: true as const,
          manifestId: "noop",
          actualSessionCount: 0,
          expectedSessionCount: 1,
          redactionPolicyVersion: POLICY_VERSION,
          sourceKind: claudeCodeSource.kind,
          endpoint: endpoint.url,
          dashboardUrl: `${endpoint.url}/dashboard`,
          classification: {
            discovered: summary.discovered,
            unchanged: summary.unchanged,
            new: summary.new,
            updated: summary.updated,
          },
          limited: summary.limited ?? { active: false },
          noop: true,
        };
        if (mode === "text") {
          process.stdout.write("No new or updated sessions.\n");
        }
        process.stdout.write(`${JSON.stringify(result)}\n`);
        return;
      }

      if (!flags.confirm && !flags.yes) {
        const ok = await confirm({
          message: `Upload ${willUpload.length} session(s) to ${endpoint.url}?`,
          default: false,
        });
        if (!ok) {
          process.stderr.write("Aborted.\n");
          process.exit(EXIT.OK);
        }
      }

      const jobs = await buildJobs(willUpload, gitBySession);
      const gitContextEvent = prLinking
        ? {
            active: true,
            sessionsWithContext: prLinking.sessionsWithContext,
            repositories: prLinking.repositories,
          }
        : undefined;
      let pipelineResult;
      try {
        pipelineResult = await runUploadPipeline({
          client,
          jobs,
          ledger,
          resumeStore,
          reporter,
          concurrency: flags.concurrency,
          policyVersion: POLICY_VERSION,
          cliVersion: getCliVersion(),
          sourceKind: claudeCodeSource.kind,
          endpointUrl: endpoint.url,
          userId: session.userId,
          ...(gitContextEvent ? { gitContext: gitContextEvent } : {}),
        });
      } catch (err) {
        if (err instanceof StaleResumeError) {
          process.stderr.write(`poppi: ${err.message}\n`);
          resumeStore.clear();
          pipelineResult = await runUploadPipeline({
            client,
            jobs,
            ledger,
            resumeStore,
            reporter,
            concurrency: flags.concurrency,
            policyVersion: POLICY_VERSION,
            cliVersion: getCliVersion(),
            sourceKind: claudeCodeSource.kind,
            endpointUrl: endpoint.url,
            userId: session.userId,
            ...(gitContextEvent ? { gitContext: gitContextEvent } : {}),
          });
        } else {
          throw err;
        }
      }

      const finalSummary = {
        command: "upload" as const,
        ok: true as const,
        manifestId: pipelineResult.manifestId,
        actualSessionCount: pipelineResult.acked.length,
        expectedSessionCount: jobs.length,
        skippedSessionCount: pipelineResult.skipped.length,
        redactionPolicyVersion: POLICY_VERSION,
        sourceKind: claudeCodeSource.kind,
        endpoint: endpoint.url,
        dashboardUrl: pipelineResult.dashboardUrl,
        classification: {
          discovered: summary.discovered,
          unchanged: summary.unchanged,
          new: summary.new,
          updated: summary.updated,
        },
        limited: summary.limited ?? { active: false },
        ...(prLinking
          ? {
              gitContext: {
                active: true,
                sessionsWithContext: prLinking.sessionsWithContext,
                repositories: prLinking.repositories,
              },
            }
          : {}),
      };
      process.stdout.write(`${JSON.stringify(finalSummary)}\n`);
    } catch (err) {
      this.bail(err);
    }
  }

  private bail(err: unknown): never {
    if (isPoppiError(err)) {
      process.stderr.write(`poppi: ${err.message}\n`);
      process.exit(err.exitCode);
    }
    if (err instanceof Error) {
      process.stderr.write(`poppi: ${err.message}\n`);
    }
    process.exit(EXIT.GENERIC_FAILURE);
  }

  // Resolve git context for each (new ∪ updated) session, memoised per distinct
  // (cwd, recordedBranch). Populates `gitBySession` with resolved contexts and
  // returns the distinct repo list. Emits at most one global notice each for the
  // two best-effort degradations (FR-008/FR-009/R-8); never fatal, no new exit code.
  private async resolveBatchGitContext(
    willUpload: SessionClassification[],
    gitBySession: Map<string, GitContext>,
    linkPrs: EffectiveLinkPrs,
  ): Promise<string[]> {
    const memo = new Map<string, Awaited<ReturnType<typeof resolveGitContext>>>();
    const repositories = new Set<string>();
    let attempted = 0;
    let gitUnavailable = 0;

    for (const item of willUpload) {
      if (item.kind === "unchanged") continue;
      attempted += 1;
      const cwd = item.parsed.cwd;
      const recordedBranch = item.parsed.recordedBranch;
      const key = `${cwd ?? ""} ${recordedBranch ?? ""}`;
      let resolution = memo.get(key);
      if (!resolution) {
        resolution = await resolveGitContext({
          ...(cwd !== undefined ? { cwd } : {}),
          ...(recordedBranch !== undefined ? { recordedBranch } : {}),
        });
        memo.set(key, resolution);
      }
      if (resolution.kind === "resolved") {
        gitBySession.set(item.identity.sessionId, resolution.gitContext);
        const { owner, name } = resolution.gitContext.repository;
        repositories.add(`${owner}/${name}`);
      } else if (resolution.kind === "git-unavailable") {
        gitUnavailable += 1;
      }
    }

    void linkPrs; // opt-in already confirmed active by the caller
    if (attempted > 0 && gitUnavailable === attempted) {
      process.stderr.write(
        "poppi: PR linking was on, but git could not be inspected; proceeding as if --link-prs were off.\n",
      );
    } else if (gitBySession.size === 0) {
      process.stderr.write(
        "poppi: PR linking was on, but no sessions had resolvable git context.\n",
      );
    }

    return [...repositories].sort();
  }
}

async function buildJobs(
  items: SessionClassification[],
  gitBySession: Map<string, GitContext>,
): Promise<SessionUploadJob[]> {
  const jobs: SessionUploadJob[] = [];
  for (const item of items) {
    if (item.kind === "unchanged") continue;
    const raw = await rawFileHash(item.ref.absolutePath);
    const gitContext = gitBySession.get(item.identity.sessionId);
    jobs.push({
      sessionId: item.identity.sessionId,
      identityDerivation: item.identity.derivation,
      formatVersion: CLAUDE_FORMAT_VERSION,
      sourceFilePath: item.ref.absolutePath,
      anonymizationResult: item.anonymizationResult,
      rawContentHashAtFirstRun: raw,
      ...(gitContext ? { gitContext } : {}),
    });
  }
  return jobs;
}

async function writeInspectionDir(
  dir: string,
  force: boolean,
  items: SessionClassification[],
  summary: ReturnType<typeof buildUploadSummary>,
  gitBySession: Map<string, GitContext>,
): Promise<void> {
  const target = path.resolve(dir);
  if (existsSync(target) && !force) {
    throw new InspectDirError(
      `--inspect directory already exists: ${target}. Use --force to overwrite.`,
    );
  }
  await mkdir(target, { recursive: true });
  const totals: Record<string, number> = {};
  const sessions: unknown[] = [];
  for (const item of items) {
    if (item.kind === "unchanged") continue;
    const fileBase = `${item.identity.sessionId}.payload.json`;
    await writeFile(
      path.join(target, fileBase),
      JSON.stringify(item.anonymizationResult.payload, null, 2),
    );
    const counts = item.anonymizationResult.redactionsByCategory;
    for (const [k, v] of Object.entries(counts)) {
      totals[k] = (totals[k] ?? 0) + v;
    }
    sessions.push({
      sessionId: item.identity.sessionId,
      sourceKind: item.ref.sourceKind,
      byteSizeBefore: item.ref.byteSizeOnDisk,
      byteSizeAfter: item.anonymizationResult.byteSize,
      counts: filterPositive(counts),
    });
  }
  const summaryFile = {
    redactionPolicyVersion: POLICY_VERSION,
    sessions,
    totals: filterPositive(totals),
    summary,
  };
  await writeFile(
    path.join(target, "redaction-summary.json"),
    JSON.stringify(summaryFile, null, 2),
  );

  // Opt-in git context is written DISTINCTLY from the redacted payloads, clearly
  // labelled as intentionally-in-clear, so a reviewer can audit exactly what would
  // be transmitted before any byte leaves the machine (FR-014). The GitContext is
  // credential-/path-free by construction (FR-015).
  if (gitBySession.size > 0) {
    const gitSessions = items
      .filter((item) => item.kind !== "unchanged" && gitBySession.has(item.identity.sessionId))
      .map((item) => ({
        sessionId: item.identity.sessionId,
        gitContext: gitBySession.get(item.identity.sessionId),
      }));
    await writeFile(
      path.join(target, "git-context.json"),
      JSON.stringify(
        {
          note: "Opt-in (--link-prs) git context — intentionally sent in clear, NOT redacted. Credential-free and path-free by construction.",
          sessions: gitSessions,
        },
        null,
        2,
      ),
    );
  }
}

function filterPositive<T extends Record<string, number>>(obj: T): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v > 0) out[k] = v;
  }
  return out;
}
