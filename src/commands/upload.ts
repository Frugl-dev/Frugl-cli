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
  type ProjectSummaryRow,
} from "../upload/summary.js";
import { createProgressReporter } from "../upload/progress.js";
import { runUploadPipeline, rawFileHash, type SessionUploadJob } from "../upload/pipeline.js";
import { resolveGitContext, type GitContext } from "../upload/git-context.js";
import { extractWorktreePath } from "../sources/claude-code/project.js";
import { resolveEffectiveLinkPrs, type EffectiveLinkPrs } from "../upload/link-prs.js";
import {
  detectProviders,
  getProvider,
  type DetectedProvider,
  type ProjectGroup,
} from "../sources/providers.js";
import { applySelection, isInteractive, selectProjects, selectProviders } from "../select/index.js";
import type { Selection } from "../select/selection.js";
import { SOURCES } from "../sources/registry.js";
import type { Source, SessionRef } from "../sources/types.js";
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
      description:
        "Opt in to attaching credential-stripped git context (repo, branch, commit) so sessions can be linked to PRs. Default off.",
    }),
    json: Flags.boolean({ description: "Emit machine-readable JSON output", default: false }),
  };

  async run(): Promise<void> {
    const { flags } = await this.parse(Upload);
    const mode = resolveOutputMode({ json: flags.json });
    const reporter = createProgressReporter(mode);
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

      const homeDir = process.env["POPPI_HOME_DIR"];
      const discoverOpts = homeDir ? { homeDir } : undefined;

      // 1) Detect which providers have sessions on this machine.
      const detected = await detectProviders(discoverOpts);
      const supportedDetected = detected.filter((d) => d.descriptor.supported);
      if (supportedDetected.length === 0) {
        const names = detected.map((d) => d.descriptor.displayName).join(", ");
        throw new NoSessionsError(
          detected.length === 0
            ? "No sessions found. Make sure at least one AI coding tool (Claude Code, Cursor, Codex, or Gemini) has been used on this machine."
            : `Detected ${names}, but none are supported for upload yet.`,
        );
      }

      // 2) Choose providers — interactive picker, or auto-select-all when not.
      const interactive = isInteractive({
        json: flags.json,
        yes: flags.yes,
        confirm: flags.confirm,
        isTTY: Boolean(process.stdin.isTTY),
      });
      const selectedProviderIds = await selectProviders(detected, { interactive });
      if (selectedProviderIds.length === 0) {
        if (mode === "text") process.stderr.write("Nothing selected.\n");
        process.exit(EXIT.OK);
      }

      // 3) Discover sessions for the selected providers and group them by project.
      const groups: ProjectGroup[] = [];
      for (const id of selectedProviderIds) {
        const descriptor = getProvider(id);
        if (!descriptor?.supported || !descriptor.source || !descriptor.deriveProjects) continue;
        const providerRefs = await descriptor.source.discover(discoverOpts);
        groups.push(...descriptor.deriveProjects(providerRefs));
      }

      // 4) Choose projects — all preselected; deselect to exclude from upload.
      const selectedProjectIds = await selectProjects(groups, { interactive });
      const selection: Selection = {
        providerIds: selectedProviderIds,
        projectIds: selectedProjectIds,
      };
      const selectionReport = buildSelectionReport(detected, groups, selection);

      const refs = applySelection(groups, selection);
      if (refs.length === 0) {
        if (mode === "text") process.stderr.write("Nothing selected.\n");
        process.exit(EXIT.OK);
      }

      const uploadId = randomUUID();
      // Group refs by source for per-source pipeline
      const refsBySource = new Map<Source, SessionRef[]>();
      for (const ref of refs) {
        const source = SOURCES.find((s) => s.kind === ref.sourceKind);
        if (!source) continue;
        const existing = refsBySource.get(source) ?? [];
        existing.push(ref);
        refsBySource.set(source, existing);
      }

      const ledger = new Ledger({ endpointUrl: endpoint.url, userId: session.userId });
      const resumeStore = new ResumeStore({ endpointUrl: endpoint.url, userId: session.userId });

      // Classify per source (each source knows how to parse its own refs)
      const classificationsBySource = new Map<Source, SessionClassification[]>();
      for (const [source, sourceRefs] of refsBySource) {
        const sorted = sourceRefs.sort(
          (a, b) => b.mtimeMs - a.mtimeMs || a.absolutePath.localeCompare(b.absolutePath),
        );
        const classifications = await classifyAll(sorted, {
          ledger,
          source,
          anonymize: { uploadId, ownerEmail: session.email },
        });
        classificationsBySource.set(source, classifications);
      }

      // Merge for confirmation + summary
      const allClassifications = [...classificationsBySource.values()].flat();
      const allBuckets = bucketize(allClassifications);
      const allCandidates: SessionClassification[] = sortByMtimeDesc([
        ...allBuckets.new,
        ...allBuckets.updated,
      ]);
      const willUpload =
        flags.limit !== undefined ? allCandidates.slice(0, flags.limit) : allCandidates;

      const activeSources = [...refsBySource.keys()];
      const displaySourceKind = activeSources.length === 1 ? activeSources[0]!.kind : "multi";

      // Opt-in git-context resolution
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

      const projectRows = buildProjectRows(willUpload, groups);
      const summary = buildUploadSummary({
        buckets: allBuckets,
        willUpload,
        policyVersion: POLICY_VERSION,
        endpoint,
        sourceKind: displaySourceKind,
        ...(prLinking ? { prLinking } : {}),
        ...(flags.limit !== undefined ? { limit: flags.limit } : {}),
        ...(projectRows.length > 0 ? { projects: projectRows } : {}),
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
          sourceKind: displaySourceKind,
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
          selection: selectionReport,
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
          sourceKind: displaySourceKind,
          endpoint: endpoint.url,
          dashboardUrl: `${endpoint.url}/dashboard`,
          classification: {
            discovered: summary.discovered,
            unchanged: summary.unchanged,
            new: summary.new,
            updated: summary.updated,
          },
          limited: summary.limited ?? { active: false },
          selection: selectionReport,
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

      // Run a separate pipeline per source — each source gets its own manifest
      let totalAcked = 0;
      let lastManifestId = "";
      let lastDashboardUrl = `${endpoint.url}/dashboard`;
      for (const [source, _classifications] of classificationsBySource) {
        const sourceCandidates = willUpload.filter((c) => c.ref.sourceKind === source.kind);
        if (sourceCandidates.length === 0) continue;

        const jobs = await buildJobsForSource(sourceCandidates, source, gitBySession);
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
            sourceKind: source.kind,
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
              sourceKind: source.kind,
              endpointUrl: endpoint.url,
              userId: session.userId,
              ...(gitContextEvent ? { gitContext: gitContextEvent } : {}),
            });
          } else {
            throw err;
          }
        }

        totalAcked += pipelineResult.acked.length;
        lastManifestId = pipelineResult.manifestId;
        lastDashboardUrl = pipelineResult.dashboardUrl;
      }

      const finalSummary = {
        command: "upload" as const,
        ok: true as const,
        selection: selectionReport,
        manifestId: lastManifestId,
        actualSessionCount: totalAcked,
        expectedSessionCount: willUpload.length,
        redactionPolicyVersion: POLICY_VERSION,
        sourceKind: displaySourceKind,
        endpoint: endpoint.url,
        dashboardUrl: lastDashboardUrl,
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
      const key = `${cwd ?? ""} ${recordedBranch ?? ""}`;
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

    void linkPrs;
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

function buildProjectRows(
  willUpload: SessionClassification[],
  groups: ProjectGroup[],
): ProjectSummaryRow[] {
  const infoById = new Map<string, { providerId: string; displayName: string }>();
  for (const g of groups) {
    infoById.set(g.projectId, { providerId: g.providerId, displayName: g.displayName });
  }
  const counts = new Map<string, number>();
  for (const item of willUpload) {
    if (item.kind === "unchanged") continue;
    const projectId = path.basename(path.dirname(item.ref.absolutePath));
    counts.set(projectId, (counts.get(projectId) ?? 0) + 1);
  }
  const rows: ProjectSummaryRow[] = [];
  for (const [projectId, count] of counts) {
    const info = infoById.get(projectId);
    rows.push({
      providerId: info?.providerId ?? "claude",
      displayName: info?.displayName ?? projectId,
      willUpload: count,
    });
  }
  rows.sort((a, b) => b.willUpload - a.willUpload || a.displayName.localeCompare(b.displayName));
  return rows;
}

function buildSelectionReport(
  detected: DetectedProvider[],
  groups: ProjectGroup[],
  selection: Selection,
) {
  const providerSel = new Set(selection.providerIds);
  const projectSel = new Set(selection.projectIds);
  return {
    providers: detected.map((d) => ({
      id: d.descriptor.id,
      displayName: d.descriptor.displayName,
      supported: d.descriptor.supported,
      selected: providerSel.has(d.descriptor.id),
    })),
    projects: groups.map((g) => ({
      providerId: g.providerId,
      projectId: g.projectId,
      displayName: g.displayName,
      sessionCount: g.sessionCount,
      selected: projectSel.has(g.projectId),
    })),
  };
}

async function buildJobsForSource(
  items: SessionClassification[],
  source: Source,
  gitBySession: Map<string, GitContext>,
): Promise<SessionUploadJob[]> {
  const jobs: SessionUploadJob[] = [];
  for (const item of items) {
    if (item.kind === "unchanged") continue;
    const raw = await rawFileHash(item.ref.absolutePath);
    const gitContext = gitBySession.get(item.identity.sessionId);
    const worktreePath = extractWorktreePath(item.ref.absolutePath);
    jobs.push({
      sessionId: item.identity.sessionId,
      identityDerivation: item.identity.derivation,
      formatVersion: source.formatVersion,
      sourceFilePath: item.ref.absolutePath,
      anonymizationResult: item.anonymizationResult,
      rawContentHashAtFirstRun: raw,
      ...(gitContext ? { gitContext } : {}),
      ...(worktreePath ? { worktreePath } : {}),
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
