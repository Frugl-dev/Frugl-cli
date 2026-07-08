import { Command, Flags } from "@oclif/core";
import { confirm } from "@inquirer/prompts";
import { Temporal } from "temporal-polyfill";
import path from "node:path";
import { bar, color, formatBytes, symbol, SIGIL } from "../lib/theme.js";
import { randomUUID } from "node:crypto";
import { CloudClient, CloudHttpError } from "../cloud/client.js";
import { resolveEndpoint, type Endpoint } from "../cloud/endpoints.js";
import { loadConfigPathPin, loadProjectPin } from "../cloud/project-pin.js";
import { AuthService } from "../auth/auth-service.js";
import { cloudIdentityClient } from "../auth/identity-client.js";
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
  buildClassification,
  formatSummaryForHuman,
  buildReport,
  formatReportHuman,
  shouldLinkPrs,
  type ProjectSummaryRow,
} from "../upload/upload-output.js";
import { createProgressReporter } from "../upload/progress.js";
import {
  runUploadPipeline,
  finalizePendingManifest,
  createRawFileHasher,
  type SessionUploadJob,
} from "../upload/pipeline.js";
import { captureDeclaredMcpServers } from "../capture/claude/mcp-inventory.js";
import { HttpCloudAdapter } from "../upload/cloud-http-adapter.js";
import { requestHandoffUrl, resolveHandoffPreference } from "../cloud/handoff.js";
import { resolveGitContext, type GitContext } from "../upload/git-context.js";
import { encodeProjectPath, extractWorktreePath } from "../sources/claude-code/project.js";
import {
  detectProviders,
  getProvider,
  getSourceByKind,
  type DetectedProvider,
  type ProjectGroup,
} from "../sources/providers.js";
import {
  applySelection,
  groupByGitProject,
  isGitRepoGroup,
  isInteractive,
  selectProjects,
  selectProviders,
} from "../select/index.js";
import type { Selection } from "../select/selection.js";
import {
  filterTrivial,
  filterByCost,
  classifyTier,
  computeSessionCostUSD,
  computeSessionMetrics,
  EXCLUDE_FLOOR_USD,
} from "../select/filter.js";
import type { Source, SessionRef } from "../sources/types.js";
import { POLICY_VERSION } from "../anonymize/index.js";
import {
  AuthError,
  NoSessionsError,
  OrgBlockedError,
  printFruglError,
  StaleResumeError,
  UsageError,
} from "../lib/errors.js";
import { EXIT } from "../lib/exit-codes.js";
import { getCliVersion } from "../lib/cli-version.js";
import {
  getLinkPrs,
  recordPendingAuthFailure,
  clearPendingAuthFailure,
  recordUploadBlocked,
  clearUploadBlocked,
} from "../lib/config.js";
import {
  loadUploadConfig,
  loadUploadConfigScope,
  resolveConfigSelection,
} from "../config/upload-config.js";
import {
  resolveDebug,
  resolveOutputMode,
  FORMAT_FLAG,
  type OutputMode,
} from "../lib/output-mode.js";

export default class Upload extends Command {
  static override description = `Discover local AI-coding session sources, anonymize them, and batch-upload to hosted Frugl.

Exit codes:
  0   success
  2   usage error (bad flags)
 10   not authenticated — run: frugl login
 20   no sessions found
 30   anonymization failure
 40   network error
 41   endpoint unreachable (--endpoint)
 50   version outdated — run: npm install -g frugl@latest

Set FRUGL_DEBUG=1 to print HTTP request/response lines to stderr.`;

  // The only positional target is `sessions`; passing it is equivalent to
  // passing nothing. Context snapshots are captured by `frugl context` alone —
  // `upload` never triggers one. oclif has no native variadic *named* arg, so
  // `strict = false` is what lets the command accept a target token; with
  // `--report` the lone positional is instead the manifest id to explain
  // (defaults to the in-flight upload).
  static override strict = false;

  static override examples = [
    "<%= config.bin %> <%= command.id %>                  # upload AI coding sessions",
    "<%= config.bin %> <%= command.id %> sessions         # same, named explicitly",
    "<%= config.bin %> <%= command.id %> --report         # explain the last upload's failures",
  ];

  static override flags = {
    yes: Flags.boolean({
      description: "Skip the interactive confirmation prompt.",
    }),
    "dry-run": Flags.boolean({ description: "Anonymize but do not transmit." }),
    // Development-only: point the CLI at a non-production cloud. Hidden from help.
    endpoint: Flags.string({ description: "Override the API endpoint.", hidden: true }),
    concurrency: Flags.integer({
      description: "Per-session upload concurrency (default 4).",
    }),
    config: Flags.string({
      description:
        "Path to a frugl.config.json declaring upload scope/options (else discovered from the cwd up).",
    }),
    limit: Flags.integer({
      description: "Maximum sessions to upload (from new and updated candidates).",
    }),
    "min-cost": Flags.string({
      // Defaults to (and floors at) $10: low-cost sessions (a stray prompt, an
      // aborted run, a quick one-off) are noise on the dashboard and cost more to
      // process than they're worth. Frugl saves money, so the floor can't go lower.
      description:
        "Skip sessions whose estimated cost is below this amount in USD (e.g. 10, 25). Default and minimum 10.00.",
      default: "10.00",
    }),
    "link-prs": Flags.boolean({
      description:
        "Opt in to attaching credential-stripped git context (repo, branch, commit) so sessions can be linked to PRs. Default off.",
    }),
    handoff: Flags.boolean({
      // No default: `undefined` means "not passed", so the interactive-TTY
      // default in resolveHandoffPreference stays detectable (research R-5).
      allowNo: true,
      description:
        "Append a single-use, short-lived sign-in code to the printed dashboard link so the browser lands signed in (--no-handoff to disable). Default: on for interactive runs, off for --format json/minimal, non-TTY, or CI.",
    }),
    format: FORMAT_FLAG,
    report: Flags.boolean({
      description:
        "Explain the last upload's failures (grouped by reason, with remedies) instead of uploading.",
      default: false,
    }),
  };

  async run(): Promise<void> {
    const { flags, argv } = await this.parse(Upload);
    const mode = resolveOutputMode({ format: flags.format });
    const reporter = createProgressReporter(mode);

    // Positionals mean different things per mode: with `--report` the first one
    // is a manifest id; otherwise they're the upload targets. Resolve targets
    // only in the upload path so `frugl upload --report <id>` isn't rejected as
    // an unknown target.
    const positionals = argv as string[];
    let uploadSessions = true;
    if (!flags.report) {
      try {
        ({ uploadSessions } = resolveUploadTargets(positionals));
      } catch (err) {
        this.bail(err, mode);
      }
    }

    // Clear the live progress bar line and tell the user how to inspect
    // partial progress. Exit 130 is the Unix convention for Ctrl-C.
    process.on("SIGINT", (): never => {
      process.stderr.write("\n");
      if (mode === "json") {
        process.stdout.write(`${JSON.stringify({ event: "interrupted" })}\n`);
      } else {
        process.stderr.write(
          color.dim("Upload interrupted. Run 'frugl upload --report' to see what was uploaded.\n"),
        );
      }
      process.exit(130);
    });

    if (flags.limit !== undefined && flags.limit <= 0) {
      this.bail(new UsageError("--limit must be a positive integer."), mode);
    }

    // Validate --min-cost up front (before auth) so a bad value fails fast with a
    // clean usage error rather than after the login flow. The floor lives in
    // parseCostFlag, which is re-used later to read the value.
    try {
      parseCostFlag(flags["min-cost"], "--min-cost");
    } catch (err) {
      this.bail(err, mode);
    }

    // Endpoint resolution must match every other cloud command (whoami, init —
    // see lib/command-context.ts): flag > FRUGL_CONFIG_PATH > checked-in
    // `.frugl.json` pin > FRUGL_ENDPOINT > default. Skipping the pin layers here
    // once sent a pinned self-host repo's bare `frugl upload` to the public
    // cloud. Both pin loads are fail-closed — a malformed pin throws (exit 2)
    // rather than silently degrading to the default endpoint.
    let endpoint: Endpoint;
    try {
      endpoint = resolveEndpoint({
        flag: flags.endpoint,
        configPath: loadConfigPathPin()?.endpoint,
        pinned: loadProjectPin()?.endpoint,
        env: process.env["FRUGL_ENDPOINT"],
      });
    } catch (err) {
      this.bail(err, mode);
    }
    try {
      // Fail-closed: a malformed/unreadable config throws here -> bail -> exit 2.
      const uploadConfig = loadUploadConfig({ explicitPath: flags.config });
      // Non-null only when a real v1 `.frugl.json` was found (not the deprecated
      // frugl.config.json fallback): its directory is the project's scope.
      const scopeDir = loadUploadConfigScope({ explicitPath: flags.config });
      if (uploadConfig?.upload?.enabled === false) {
        if (mode !== "json") {
          process.stderr.write(color.dim("Upload disabled in .frugl.json — nothing sent.\n"));
        } else {
          process.stdout.write(
            `${JSON.stringify({ command: "upload", ok: true, skipped: true, reason: "disabled" })}\n`,
          );
        }
        return;
      }
      const autoMode = uploadConfig?.upload?.auto ?? false;
      // Precedence (FR-026): flag > config file > default. The summary builder
      // owns the precedence rule; the command only asks whether linking is active
      // so it can decide whether to run the (expensive) git-context pass.
      const configLinkPrs = uploadConfig?.upload?.linkPrs ?? getLinkPrs();
      const linkActive = shouldLinkPrs(flags["link-prs"], configLinkPrs);
      const concurrency = flags.concurrency ?? uploadConfig?.upload?.concurrency ?? 4;

      const auth = new AuthService({
        endpointUrl: endpoint.url,
        identity: cloudIdentityClient({
          endpointUrl: endpoint.url,
          endpointExplicit: endpoint.resolvedFrom !== "default",
          endpointSource: endpoint.resolvedFrom,
          cliVersion: getCliVersion(),
        }),
      });
      // Non-interactive auth (CI / hooks) comes from FRUGL_TOKEN or a prior
      // `frugl login` (incl. `login --token`); upload itself takes no token flag.
      const session = await auth.resolveRequestAuth({});
      const client = new CloudClient({
        endpointUrl: endpoint.url,
        cliVersion: getCliVersion(),
        token: session.token,
        endpointExplicit: endpoint.resolvedFrom !== "default",
        endpointSource: endpoint.resolvedFrom,
        debug: resolveDebug(),
      });
      const cloud = new HttpCloudAdapter(client);

      // `--report`: explain the in-flight manifest's failures and exit — no
      // discovery, no upload. Reads the resume store (keyed by endpoint + user),
      // which holds failed sessions while they sit pending and resumable.
      if (flags.report) {
        this.runReport({
          endpointUrl: endpoint.url,
          userId: session.userId,
          requestedManifestId: positionals[0],
          mode,
        });
      }

      // Shared accumulators — set inside the sessions block, read by the final
      // output section.
      let totalAcked = 0;
      let lastManifestId = "";
      let lastDashboardUrl = `${endpoint.url}/dashboard`;

      // Session-summary variables — populated inside the sessions block and used
      // in the final JSON output. Declared here so they're in scope after the block.
      let summary: ReturnType<typeof buildUploadSummary> | undefined;
      let prLinking: ReturnType<typeof buildUploadSummary>["prLinking"];
      let selectionReport: ReturnType<typeof buildSelectionReport> | undefined;
      let willUpload: SessionClassification[] = [];
      let displaySourceKind = "multi";

      if (uploadSessions) {
        const homeDir = process.env["FRUGL_HOME_DIR"];
        const discoverOpts = homeDir ? { homeDir } : undefined;

        if (mode === "default")
          process.stderr.write(color.dim("Sniffing out AI sessions on this machine…\n"));

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

        const interactive = isInteractive({
          mode,
          yes: flags.yes || autoMode,
          isTTY: Boolean(process.stdin.isTTY),
        });

        const groups: ProjectGroup[] = [];

        const uploadId = randomUUID();
        const minCost = parseCostFlag(flags["min-cost"], "--min-cost");
        const ledger = new Ledger({
          endpointUrl: endpoint.url,
          userId: session.userId,
        });
        const resumeStore = new ResumeStore({
          endpointUrl: endpoint.url,
          userId: session.userId,
        });

        // Parse + anonymize a set of refs, grouped per source (each source knows
        // how to parse its own files). This is the heaviest local pass and prints
        // nothing on its own — at hundreds of sessions it reads as a hang — so we
        // paint a live progress bar. classifyAll bounds its own concurrency so a
        // big batch doesn't fan out and stall. The bar obeys the output-mode
        // contract via liveLocalProgress: rich in default, silent in minimal/json.
        const homeDirOverride = process.env["FRUGL_HOME_DIR"];
        const classifyRefs = async (toParse: SessionRef[]): Promise<SessionClassification[]> => {
          const bySource = new Map<Source, SessionRef[]>();
          for (const ref of toParse) {
            const source = getSourceByKind(ref.sourceKind);
            if (!source) continue;
            const list = bySource.get(source) ?? [];
            list.push(ref);
            bySource.set(source, list);
          }
          const total = [...bySource.values()].reduce((n, r) => n + r.length, 0);
          const progress = liveLocalProgress(
            mode,
            total,
            "parsing sessions",
            `Parsing ${total} sessions on your machine…`,
          );
          const out: SessionClassification[] = [];
          for (const [source, sourceRefs] of bySource) {
            const sorted = sourceRefs.toSorted(
              (a, b) => b.mtimeMs - a.mtimeMs || a.absolutePath.localeCompare(b.absolutePath),
            );
            const classifications = await classifyAll(
              sorted,
              {
                ledger,
                source,
                anonymize: {
                  uploadId,
                  ownerEmail: session.email,
                  ...(homeDirOverride !== undefined ? { homeDir: homeDirOverride } : {}),
                },
              },
              () => progress.tick(),
            );
            out.push(...classifications);
          }
          progress.done();
          return out;
        };

        // The sessions that would actually be sent from a classified set:
        // new/updated (never unchanged) that survive the trivial filter and clear
        // the $0.01 floor (spec 054). Both metadata-only ($0.01..min) and full
        // (>= min) sessions are sent; only empty (< $0.01) ones are dropped. Used
        // for both the picker counts and the final willUpload. Kept local for
        // readability next to its callers, though it no longer closes over scope.
        // eslint-disable-next-line unicorn/consistent-function-scoping
        const eligibleFrom = (cs: SessionClassification[]): SessionClassification[] => {
          const buckets = bucketize(cs);
          const candidates = sortByMtimeDesc([...buckets.new, ...buckets.updated]);
          const notTrivial = filterTrivial(candidates);
          return filterByCost(notTrivial, EXCLUDE_FLOOR_USD);
        };

        let selection: Selection;
        let allClassifications: SessionClassification[];

        if (uploadConfig) {
          // Config-driven scope: derive all supported providers' projects, then
          // either scope to the .frugl.json directory or filter by the deprecated
          // frugl.config.json's providers + project include/exclude globs. No
          // picker either way.
          for (const d of supportedDetected) {
            const descriptor = getProvider(d.descriptor.id);
            if (!descriptor?.supported || !descriptor.source || !descriptor.deriveProjects)
              continue;
            const providerRefs = await descriptor.source.discover(discoverOpts);
            groups.push(...descriptor.deriveProjects(providerRefs));
          }

          if (scopeDir !== null) {
            // A .frugl.json's mere presence IS the project declaration — scope
            // strictly to the directory that contains it, no include/exclude
            // globs needed. upload.providers defaults to all supported but can
            // restrict the set.
            const supportedIds = supportedDetected.map((d) => d.descriptor.id);
            const providerIds = uploadConfig.providers
              ? supportedIds.filter((id) => uploadConfig.providers!.includes(id))
              : supportedIds;
            const providerSet = new Set(providerIds);
            const scopedGroups = groups.filter(
              (g) => providerSet.has(g.providerId) && groupMatchesScopeDir(g, scopeDir),
            );
            selection = {
              providerIds,
              projectIds: scopedGroups.map((g) => g.projectId),
            };
          } else {
            selection = resolveConfigSelection(uploadConfig, detected, groups);
          }
          allClassifications = await classifyRefs(applySelection(groups, selection));
        } else {
          // 2) Choose providers — interactive picker, or auto-select-all when not.
          const selectedProviderIds = await selectProviders(detected, { interactive });
          if (selectedProviderIds.length === 0) {
            // Only reachable when the interactive picker ends with every provider
            // unchecked: zero *supported* providers already threw NoSessionsError
            // above, and the non-interactive path auto-selects all of them.
            const explanation = explainNoProvidersSelected(supportedDetected);
            if (mode === "json") {
              process.stdout.write(
                `${JSON.stringify({
                  command: "upload",
                  ok: true,
                  selected: 0,
                  endpoint: endpoint.url,
                  reason: explanation.reason,
                })}\n`,
              );
            } else {
              process.stderr.write(color.dim(`${explanation.human}\n`));
            }
            process.exit(EXIT.OK);
          }
          // 3) Discover sessions for the selected providers, grouped by project.
          for (const id of selectedProviderIds) {
            const descriptor = getProvider(id);
            if (!descriptor?.supported || !descriptor.source || !descriptor.deriveProjects)
              continue;
            const providerRefs = await descriptor.source.discover(discoverOpts);
            groups.push(...descriptor.deriveProjects(providerRefs));
          }
          // Parse every discovered session up front so the project picker can show
          // counts that reflect what will actually upload after --min-cost. Cost is
          // only knowable by reading each file, so this heavy pass precedes the picker.
          allClassifications = await classifyRefs(groups.flatMap((g) => g.sessions));
          const byPath = new Map<string, SessionClassification>();
          for (const c of allClassifications) byPath.set(c.ref.absolutePath, c);

          // Relabel the picker by GitHub repo instead of on-disk path: resolve
          // each group's recorded cwd to its git `origin` remote and collapse
          // groups that map to the same repo (apps/web, packages/*, worktrees…
          // all become one `owner/name` row). Only new/updated sessions carry a
          // parsed cwd; groups with none fall back to their decoded path. Done
          // here — after parsing, before the picker — so counts stay per-repo.
          const cwdByPath = new Map<string, string>();
          for (const c of allClassifications) {
            if ("parsed" in c && c.parsed.cwd) cwdByPath.set(c.ref.absolutePath, c.parsed.cwd);
          }
          const repoGroups = await groupByGitProject(groups, (g) => {
            // Every distinct recorded cwd in the group, then the decoded path as a
            // last resort (covers already-uploaded projects whose sessions are all
            // "unchanged" and so carry no parsed cwd). Stale/deleted cwds resolve
            // to nothing and are skipped; resolveRepositoryIdentity stats each
            // first, so a lossy decode that isn't on disk just keeps the path label.
            const candidates: string[] = [];
            for (const s of g.sessions) {
              const cwd = cwdByPath.get(s.absolutePath);
              if (cwd !== undefined && !candidates.includes(cwd)) candidates.push(cwd);
            }
            if (g.displayName.startsWith("/")) candidates.push(g.displayName);
            return candidates;
          });
          groups.length = 0;
          groups.push(...repoGroups);

          const counts = new Map<string, number>();
          for (const g of groups) {
            const cs = g.sessions
              .map((s) => byPath.get(s.absolutePath))
              .filter((c): c is SessionClassification => c !== undefined);
            counts.set(g.projectId, eligibleFrom(cs).length);
          }
          // 4) Choose projects — labelled with cost-aware counts. Projects with
          // nothing left to upload, or with no git remote (local-only code), are
          // shown but deselected by default so the user opts into them by hand.
          const noRemote = new Set(
            groups.filter((g) => !isGitRepoGroup(g)).map((g) => g.projectId),
          );
          const selectedProjectIds = await selectProjects(groups, {
            interactive,
            counts,
            deselect: noRemote,
            ...(minCost !== undefined ? { minCost } : {}),
          });
          selection = {
            providerIds: selectedProviderIds,
            projectIds: selectedProjectIds,
          };
        }
        selectionReport = buildSelectionReport(detected, groups, selection);

        const selectedRefs = applySelection(groups, selection);
        if (selectedRefs.length === 0) {
          // Sessions/providers were discovered, but the selection came out empty
          // — say why (scope, filters, or the picker), never a bare "Nothing
          // selected." (which read as a bug when the cause was a `.frugl.json`
          // scoping the run to a different project).
          const explanation = explainEmptySelection({
            groups,
            classifications: allClassifications,
            scopeDir,
            minCostUsd: minCost ?? MIN_COST_FLOOR_USD,
          });
          if (mode === "json") {
            process.stdout.write(
              `${JSON.stringify({
                command: "upload",
                ok: true,
                selected: 0,
                endpoint: endpoint.url,
                reason: explanation.reason,
                selection: selectionReport,
              })}\n`,
            );
          } else {
            process.stderr.write(color.dim(`${explanation.human}\n`));
          }
          process.exit(EXIT.OK);
        }

        // Keep only the classifications for the selected projects — already parsed
        // above, so no file is read twice.
        const selectedPaths = new Set(selectedRefs.map((r) => r.absolutePath));
        const selectedClassifications = allClassifications.filter((c) =>
          selectedPaths.has(c.ref.absolutePath),
        );

        // Group selected classifications by source for the per-source pipeline.
        const classificationsBySource = new Map<Source, SessionClassification[]>();
        for (const c of selectedClassifications) {
          const source = getSourceByKind(c.ref.sourceKind);
          if (!source) continue;
          const list = classificationsBySource.get(source) ?? [];
          list.push(c);
          classificationsBySource.set(source, list);
        }

        // Merge for confirmation + summary
        const allBuckets = bucketize(selectedClassifications);
        const eligible = eligibleFrom(selectedClassifications);
        willUpload = flags.limit !== undefined ? eligible.slice(0, flags.limit) : eligible;

        // Tiering breakdown for the preview (spec 054): of the non-trivial
        // candidates, how many upload metadata-only ($0.01..min) vs are excluded
        // as empty (< $0.01). `willUpload` already excludes the empty ones; this
        // just labels the split so a thin upload reads as deliberate tiering.
        const fullThreshold = minCost ?? MIN_COST_FLOOR_USD;
        let metadataOnly = 0;
        let excludedEmpty = 0;
        {
          const candidates = sortByMtimeDesc([...allBuckets.new, ...allBuckets.updated]);
          const notTrivial = filterTrivial(candidates).filter((c) => c.kind !== "unchanged");
          for (const c of notTrivial) {
            const tier = classifyTier(
              computeSessionCostUSD(c.parsed.records, c.ref.sourceKind),
              fullThreshold,
            );
            if (tier === "excluded") excludedEmpty += 1;
            else if (tier === "metadata") metadataOnly += 1;
          }
        }

        const activeSources = [...classificationsBySource.keys()];
        displaySourceKind = activeSources.length === 1 ? activeSources[0]!.kind : "multi";

        // Opt-in git-context resolution: only run the (expensive) git pass when
        // linking is active. It shells out to git once per unique repo/branch, so
        // a big batch is another silent local pass — show the same live bar.
        const gitBySession = new Map<string, GitContext>();
        let gitContext: { sessionsWithContext: number; repositories: string[] } | undefined;
        if (linkActive) {
          const gitTotal = willUpload.filter((i) => i.kind !== "unchanged").length;
          const gitProgress = liveLocalProgress(
            mode,
            gitTotal,
            "linking git context",
            `Resolving git context for ${gitTotal} sessions…`,
          );
          const repositories = await this.resolveBatchGitContext(willUpload, gitBySession, () =>
            gitProgress.tick(),
          );
          gitProgress.done();
          gitContext = { sessionsWithContext: gitBySession.size, repositories };
        }

        const projectRows = buildProjectRows(willUpload, groups);
        summary = buildUploadSummary({
          buckets: allBuckets,
          willUpload,
          policyVersion: POLICY_VERSION,
          endpoint,
          sourceKind: displaySourceKind,
          linkPrs: { flagValue: flags["link-prs"], configValue: configLinkPrs },
          ...(gitContext ? { gitContext } : {}),
          ...(flags.limit !== undefined ? { limit: flags.limit } : {}),
          ...(projectRows.length > 0 ? { projects: projectRows } : {}),
          ...(minCost !== undefined ? { minCost } : {}),
          ...(metadataOnly > 0 ? { metadataOnly } : {}),
          ...(excludedEmpty > 0 ? { excludedEmpty } : {}),
        });
        prLinking = summary.prLinking;

        // The decorated summary table is human output — default only. minimal/json
        // get the terse per-batch reporter lines and the final JSON respectively.
        if (mode === "default") {
          process.stdout.write(`${formatSummaryForHuman(summary)}\n`);
        }

        if (flags["dry-run"]) {
          if (mode !== "json") {
            process.stdout.write(
              `\n${color.dim("Dry-run — anonymized, nothing transmitted.")}  ${color.bold("0 bytes sent.")}\n`,
            );
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
            classification: buildClassification(summary),
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
          if (mode === "json") process.stdout.write(`${JSON.stringify(result)}\n`);
          return;
        }

        // A previous run may have PUT every session but died before (or during)
        // completeManifest, leaving resume state with no pending work. Finish
        // that handshake first — even when this run has nothing new — so those
        // sessions actually become visible on the dashboard.
        try {
          const finalized = await finalizePendingManifest({
            cloud,
            resumeStore,
          });
          if (finalized) {
            lastManifestId = finalized.manifestId;
            lastDashboardUrl = finalized.dashboardUrl;
            if (mode === "default") {
              process.stderr.write(color.dim("Completed a previously interrupted upload batch.\n"));
            }
          }
        } catch {
          // Completion is still failing transiently; the state is kept and the
          // next run will retry. Never block this run's work on it.
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
            classification: buildClassification(summary!),
            limited: summary!.limited ?? { active: false },
            selection: selectionReport,
            noop: true,
          };
          if (mode !== "json") {
            process.stdout.write(
              `${color.dim("No new or updated sessions. Nothing to upload.")}\n`,
            );
          }
          if (mode === "json") process.stdout.write(`${JSON.stringify(result)}\n`);
          return;
        }

        if (willUpload.length > 0) {
          if (!flags.yes && !autoMode) {
            const ok = await confirm({
              message: `Upload ${willUpload.length} session${willUpload.length === 1 ? "" : "s"} to ${endpoint.url}?`,
              default: true,
            });
            if (!ok) {
              process.stderr.write(color.dim("Aborted. 0 bytes sent.\n"));
              process.exit(EXIT.OK);
            }
          }

          // Run a separate pipeline per source — each source gets its own manifest
          for (const [source, _classifications] of classificationsBySource) {
            const sourceCandidates = willUpload.filter((c) => c.ref.sourceKind === source.kind);
            if (sourceCandidates.length === 0) continue;

            const jobs = await buildJobsForSource(
              sourceCandidates,
              source,
              gitBySession,
              minCost ?? MIN_COST_FLOOR_USD,
            );
            const gitContextEvent = prLinking
              ? {
                  active: true,
                  sessionsWithContext: prLinking.sessionsWithContext,
                  repositories: prLinking.repositories,
                }
              : undefined;

            // Declared MCP inventory (names-only, fail-open): each source's own
            // `mcp list` command, when one is registered (claude/codex/gemini).
            const mcpServers = captureDeclaredMcpServers(undefined, source.kind);

            const pipelineOptions = {
              cloud,
              jobs,
              ledger,
              resumeStore,
              reporter,
              concurrency,
              policyVersion: POLICY_VERSION,
              cliVersion: getCliVersion(),
              sourceKind: source.kind,
              endpointUrl: endpoint.url,
              userId: session.userId,
              ...(gitContextEvent ? { gitContext: gitContextEvent } : {}),
              ...(mcpServers ? { mcpServers } : {}),
            };

            let pipelineResult;
            try {
              pipelineResult = await runUploadPipeline(pipelineOptions);
            } catch (err) {
              if (err instanceof StaleResumeError) {
                if (mode !== "json") {
                  process.stderr.write(`${color.warn(`${symbol.resume} ${err.message}`)}\n`);
                }
                resumeStore.clear();
                pipelineResult = await runUploadPipeline(pipelineOptions);
              } else {
                throw err;
              }
            }

            totalAcked += pipelineResult.acked.length;
            lastManifestId = pipelineResult.manifestId;
            lastDashboardUrl = pipelineResult.dashboardUrl;
          }
        } // end if (willUpload.length > 0)
      } // end if (uploadSessions)

      // When upload.auto is set in .frugl.json, treat upload as the full "sync"
      // command: run snapshot automatically so context + MCP inventory stay fresh
      // alongside the session data. Failure is non-fatal — it is printed but does
      // not affect the upload's exit code (snapshot exits via this.exit, so its
      // failure surfaces here as a catchable ExitError, never a process.exit).
      if (autoMode && uploadConfig?.snapshot?.enabled !== false) {
        const snapshotArgv: string[] = [];
        if (flags.endpoint) snapshotArgv.push("--endpoint", flags.endpoint);
        try {
          await this.config.runCommand("snapshot", snapshotArgv);
        } catch {
          if (mode !== "json") {
            process.stderr.write(
              color.dim("Snapshot failed — sessions uploaded fine; it will retry next run.\n"),
            );
          }
        }
      }

      // The payoff. The one place upload lets itself celebrate — a receipt that
      // makes the redaction story tangible: what was scrubbed on your machine,
      // what actually left it, and the number that matters (0 raw secrets sent).
      if (uploadSessions && totalAcked > 0 && mode === "default") {
        let totalRedactions = 0;
        for (const item of willUpload) {
          if (item.kind === "unchanged") continue;
          for (const v of Object.values(item.anonymizationResult.redactionsByCategory)) {
            totalRedactions += v;
          }
        }
        const bytes = summary ? formatBytes(summary.estimatedBytesCompressed) : "0 B";
        const w = 28;
        const rrow = (lbl: string, value: string): void => {
          process.stdout.write(`    ${color.mute(lbl.padEnd(w))}${value}\n`);
        };
        process.stdout.write(`\n  ${color.frog(SIGIL)}  ${color.frog("nice.")}\n\n`);
        process.stdout.write(`  ${color.mute("THIS BATCH")}\n`);
        rrow(
          "Redacted on your machine",
          `${color.bold(totalRedactions.toLocaleString("en-US"))} ${color.dim("secrets")}`,
        );
        rrow("Left your laptop", color.bold(bytes));
        rrow(
          "Raw secrets transmitted",
          `${color.frogBold("0 bytes")}   ${color.dim("← the number that matters")}`,
        );
      }

      // CLI→web handoff (006): decorate the final dashboard link with a
      // single-use sign-in code. Total function — any issuance failure leaves
      // the plain URL and the upload's outcome untouched (FR-008).
      const handoff = await requestHandoffUrl(
        client,
        lastDashboardUrl,
        resolveHandoffPreference(flags.handoff, Boolean(process.stdout.isTTY), mode),
      );
      if (mode !== "json") {
        process.stdout.write(
          `${color.dim("  Dashboard: ")}${color.frog(color.underline(handoff.dashboardUrl))}\n`,
        );
        if (handoff.active) {
          process.stdout.write(color.dim("             auto sign-in link — valid for ~60s\n"));
        } else if (handoff.reason !== "disabled-flag" && handoff.reason !== "disabled-default") {
          process.stdout.write(
            color.dim("             sign-in link unavailable — log in on the web\n"),
          );
        }
      }

      if (summary === undefined || selectionReport === undefined) return;

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
        dashboardUrl: handoff.dashboardUrl,
        // Additive contract (006 data-model.md): present when issuance was
        // attempted or explicitly opted out; absent on the default-off path so
        // existing --json consumers see byte-identical output.
        ...(handoff.active
          ? { handoff: { active: true as const, expiresAt: handoff.expiresAt } }
          : handoff.reason === "disabled-default"
            ? {}
            : { handoff: { active: false as const, reason: handoff.reason } }),
        classification: buildClassification(summary),
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
      // A real upload round-tripped successfully (dry-run returned earlier), so
      // the token is healthy — drop any stale background-failure breadcrumb left
      // by an earlier hook run, and any cached org-blocked verdict (the server
      // just accepted an upload, so the block is over). Best-effort; never fail
      // a good upload over it.
      try {
        clearPendingAuthFailure(endpoint.url);
        clearUploadBlocked(endpoint.url);
      } catch {
        /* ignore — the breadcrumb is a convenience, not a contract */
      }

      if (mode === "json") process.stdout.write(`${JSON.stringify(finalSummary)}\n`);
    } catch (err) {
      this.bail(err, mode, endpoint.url);
    }
  }

  private bail(err: unknown, mode: OutputMode = "default", endpointUrl?: string): never {
    // A background run (the Claude Code hook, CI) dies on auth with no human
    // watching its stderr. Leave a breadcrumb so the next interactive command
    // surfaces it. Best-effort; never let it mask the real error below.
    if (err instanceof AuthError && endpointUrl) {
      try {
        recordPendingAuthFailure(endpointUrl);
      } catch {
        /* ignore — the breadcrumb is a convenience, not a contract */
      }
    }

    // The billing gate refused the upload before any bytes were sent (spec 060).
    // This is an expected business state, not a CLI failure: surface the quota +
    // upgrade link and exit 0 so a hook/CI run isn't poisoned. JSON consumers get
    // a structured `blocked` marker on an otherwise-ok envelope.
    if (err instanceof OrgBlockedError) {
      // Cache the verdict (TTL'd) so hook-triggered runs skip the whole
      // discovery/anonymize pass instead of re-earning the same refusal every
      // session end. Cleared by the next successful upload or fresh login.
      if (endpointUrl) {
        try {
          recordUploadBlocked(endpointUrl);
        } catch {
          /* ignore — the cache is a convenience, not a contract */
        }
      }
      if (mode === "json") {
        process.stdout.write(
          `${JSON.stringify({
            command: "upload",
            ok: true,
            blocked: {
              reason: err.reason,
              used: err.used,
              limit: err.limit,
              expiresAt: err.expiresAt,
              upgradeUrl: err.upgradeUrl,
            },
          })}\n`,
        );
      } else if (mode === "minimal") {
        process.stderr.write(`frugl: ${err.message}\n`);
      } else {
        process.stderr.write(renderOrgBlockedHuman(err));
      }
      process.exit(EXIT.OK);
    }

    if (
      err instanceof CloudHttpError &&
      err.status === 409 &&
      (err.body as Record<string, unknown>)?.error === "org_required"
    ) {
      if (mode === "default") {
        process.stderr.write(
          `${color.err("frugl: You're signed in, but you're not in any org.")}\n\n`,
        );
        process.stderr.write(`${color.dim("  Every upload belongs to an org. Pick one:")}\n\n`);
        process.stderr.write(
          `    ${color.frog("frugl org create")}        ${color.dim("start a new org (you become owner)")}\n`,
        );
        process.stderr.write(
          `    ${color.frog("frugl org join <code>")}   ${color.dim("accept an invite from a teammate")}\n`,
        );
        process.stderr.write(
          `    ${color.frog("frugl logout")}            ${color.dim("this isn't the right account")}\n`,
        );
      } else {
        process.stderr.write(
          "frugl: You're signed in, but you're not in any org. Run 'frugl org create' or 'frugl org join <code>'.\n",
        );
      }
      process.exit(EXIT.GENERIC_FAILURE);
    }

    // Warm error — honest failure, zero blame. Cause · fix · reassurance, with
    // the stable exit code preserved. The hero "you're not signed in" moment.
    if (err instanceof AuthError && mode === "default") {
      const e = process.stderr;
      e.write(
        `\n  ${color.warn(SIGIL)}   ${color.bold("Hold on — you're not signed in yet.")}\n\n`,
      );
      e.write(
        `  ${color.dim("Frugl needs to know who you are before it sends anything. That's the")}\n`,
      );
      e.write(`  ${color.dim("whole reason nothing left your machine just now.")}\n\n`);
      e.write(
        `    ${color.frog("→")} ${color.frog("frugl login")}   ${color.dim("email code, about ten seconds.")}\n\n`,
      );
      e.write(
        `  ${color.ok(symbol.tick)} ${color.dim("Nothing was uploaded.")}   ${color.ok(symbol.tick)} ${color.dim("No token written.")}\n\n`,
      );
      e.write(
        `  ${color.dim("Exit 10 (AUTH_FAILURE) — same stable code your scripts already check.")}\n`,
      );
      process.exit(EXIT.AUTH_FAILURE);
    }

    // Warm empty state — nothing to upload is not an error to shout about. Only
    // the truly-empty case; the "detected but unsupported" message stays generic.
    if (
      err instanceof NoSessionsError &&
      mode === "default" &&
      !err.message.includes("supported")
    ) {
      const e = process.stderr;
      e.write(`\n  ${color.frog(SIGIL)}   ${color.bold("Nothing to upload yet.")}\n\n`);
      e.write(
        `  ${color.dim("Frugl looked in the usual spots and came up empty-handed — no sessions found:")}\n`,
      );
      e.write(`    ${color.mute("·")} Claude Code   ${color.dim("~/.claude/projects")}\n`);
      e.write(`    ${color.mute("·")} Codex         ${color.dim("~/.codex/sessions")}\n`);
      e.write(
        `    ${color.mute("·")} Cursor        ${color.dim("~/Library/Application Support/Cursor")}\n\n`,
      );
      e.write(
        `  ${color.dim("That's expected on a fresh machine. Use an AI coding tool for a bit,")}\n`,
      );
      e.write(
        `  ${color.dim("then run ")}${color.frog("frugl upload")}${color.dim(" again.")}\n\n`,
      );
      e.write(
        `  ${color.dim("Tool in an odd spot? Point ")}${color.frog("FRUGL_HOME_DIR")}${color.dim(" at it.")}\n\n`,
      );
      e.write(`  ${color.dim("Exit 20 (NO_SESSIONS_FOUND)")}\n`);
      process.exit(EXIT.NO_SESSIONS_FOUND);
    }

    process.exit(printFruglError(err, mode));
  }

  // Render `frugl upload --report` and exit. Never returns.
  private runReport(input: {
    endpointUrl: string;
    userId: string;
    requestedManifestId: string | undefined;
    mode: OutputMode;
  }): never {
    const { endpointUrl, userId, requestedManifestId, mode } = input;
    const resumeStore = new ResumeStore({ endpointUrl, userId });
    const state = resumeStore.load();
    const matches =
      state !== null &&
      (requestedManifestId === undefined || state.manifest.manifestId === requestedManifestId);

    if (!matches) {
      if (mode === "json") {
        process.stdout.write(
          `${JSON.stringify({ command: "upload-report", ok: true, report: null })}\n`,
        );
      } else {
        process.stdout.write(
          `${color.dim(
            requestedManifestId
              ? `No in-flight manifest ${requestedManifestId} to report — failed sessions clear once they upload.`
              : "No in-flight upload to report. Run 'frugl upload' first.",
          )}\n`,
        );
      }
      process.exit(EXIT.OK);
    }

    const report = buildReport(state);
    if (mode === "json") {
      process.stdout.write(
        `${JSON.stringify({ command: "upload-report", ok: report.counts.failed === 0, report })}\n`,
      );
    } else {
      process.stdout.write(`${formatReportHuman(report)}\n`);
    }
    process.exit(EXIT.OK);
  }

  private async resolveBatchGitContext(
    willUpload: SessionClassification[],
    gitBySession: Map<string, GitContext>,
    onProgress?: () => void,
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
      onProgress?.();
    }

    if (attempted > 0 && gitUnavailable === attempted) {
      process.stderr.write(
        `${color.warn(`${symbol.warn} PR linking was on, but git could not be inspected`)}${color.dim("; proceeding as if --link-prs were off.")}\n`,
      );
    } else if (gitBySession.size === 0) {
      process.stderr.write(
        `${color.warn(`${symbol.warn} PR linking was on, but no sessions had resolvable git context.`)}\n`,
      );
    }

    return [...repositories].toSorted();
  }
}

// A live progress bar for the heavy *local* pre-upload passes (redaction,
// git-context resolution). It mirrors the upload bar's look and obeys the
// output-mode contract: animate in place only in interactive default mode on a
// TTY; default on a non-TTY prints one static line so a human isn't staring at
// a frozen cursor; minimal/json stay silent so agent/CI output is terse.
// Callers drive it with tick() per unit of work and done() to clear the line.
function liveLocalProgress(
  mode: OutputMode,
  total: number,
  liveLabel: string,
  staticLabel: string,
): { tick: () => void; done: () => void } {
  const animate = mode === "default" && Boolean(process.stderr.isTTY) && total > 0;
  let completed = 0;
  const render = (): void => {
    if (!animate) return;
    const filled = (completed / total) * 32;
    process.stderr.write(
      `\r\x1b[K  ${bar(filled, 32)}  ${completed} / ${total}  ${color.dim(liveLabel)}`,
    );
  };
  if (mode === "default" && total > 0 && !animate) {
    process.stderr.write(color.dim(`${staticLabel}\n`));
  }
  render();
  return {
    tick: () => {
      completed += 1;
      render();
    },
    done: () => {
      if (animate) process.stderr.write("\r\x1b[K");
    },
  };
}

// Warm, blame-free rendering of a billing-gate block (default mode). Mirrors the
// `org_required` and not-signed-in screens: a frog sigil, the cause, what's
// reassuring (nothing left the machine), and the one action that fixes it.
function renderOrgBlockedHuman(err: OrgBlockedError): string {
  const lines: string[] = [""];
  if (err.reason === "trial_expired") {
    lines.push(`  ${color.frog(SIGIL)}   ${color.bold("Your Frugl trial has ended.")}`);
    lines.push("");
    if (err.expiresAt) {
      lines.push(`  ${color.dim(`Your free trial ended ${formatBlockDate(err.expiresAt)}.`)}`);
    }
    lines.push(`  ${color.dim("Nothing was uploaded — your sessions never left this machine.")}`);
    lines.push(`  ${color.dim("Upgrade to keep shipping them to Frugl:")}`);
  } else {
    lines.push(`  ${color.frog(SIGIL)}   ${color.bold("Your org is over its plan limit.")}`);
    lines.push("");
    lines.push(
      `  ${color.dim(
        `${err.used.toLocaleString("en-US")} of ${err.limit.toLocaleString("en-US")} sessions used this period. Nothing was uploaded.`,
      )}`,
    );
    lines.push(
      `  ${color.dim(
        err.expiresAt
          ? `Upgrade for more headroom — or your limit resets ${formatBlockDate(err.expiresAt)}:`
          : "Upgrade for more headroom:",
      )}`,
    );
  }
  lines.push("");
  lines.push(`    ${color.frog("→")} ${color.frog(color.underline(err.upgradeUrl))}`);
  lines.push("");
  lines.push(
    `  ${color.ok(symbol.tick)} ${color.dim("Nothing was uploaded.")}   ${color.dim("Exit 0 (OK)")}`,
  );
  lines.push("");
  return `${lines.join("\n")}\n`;
}

// Human-friendly absolute date for a billing instant (trial end / limit reset).
// Falls back to the raw string if it isn't a parseable date.
function formatBlockDate(iso: string): string {
  try {
    return Temporal.Instant.from(iso).toLocaleString("en-US", {
      month: "short",
      day: "numeric",
      year: "numeric",
    });
  } catch {
    return iso;
  }
}

function buildProjectRows(
  willUpload: SessionClassification[],
  groups: ProjectGroup[],
): ProjectSummaryRow[] {
  // Map each session back to its group so the rows match whatever the picker
  // showed — repo-keyed groups in the interactive path, path-keyed in the config
  // path. Falls back to the encoded dir name only for a ref that lost its group.
  const groupByRefPath = new Map<string, ProjectGroup>();
  for (const g of groups) for (const s of g.sessions) groupByRefPath.set(s.absolutePath, g);
  const infoById = new Map<string, { providerId: string; displayName: string }>();
  const counts = new Map<string, number>();
  for (const item of willUpload) {
    if (item.kind === "unchanged") continue;
    const g = groupByRefPath.get(item.ref.absolutePath);
    const projectId = g?.projectId ?? path.basename(path.dirname(item.ref.absolutePath));
    if (g && !infoById.has(projectId)) {
      // g.displayName is either a git "owner/name" label (from groupByGitProject)
      // or a filesystem path. A path came from decodeProjectPath, which is lossy
      // — Claude encodes both "/" and "." as "-", so decoding turns every "-"
      // back into "/" and mangles real hyphens ("Frugl-Cli" → "Frugl/Cli"). When
      // the label is a path, prefer the session's recorded cwd: it's the
      // ground-truth absolute path, never round-tripped through the lossy encode.
      const isPathLabel = g.displayName.startsWith("/");
      const displayName = isPathLabel && item.parsed.cwd ? item.parsed.cwd : g.displayName;
      infoById.set(projectId, { providerId: g.providerId, displayName });
    }
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

// Does this group belong to (or under) the directory that declared it via
// `.frugl.json`? Claude's `projectId` is the raw on-disk encoded directory name
// (see deriveClaudeProjects), and its encoding ("/" and "." both become "-") is
// lossy to decode — a real path segment containing "-" (e.g. "frugl-cli") is
// indistinguishable from a path separator once decoded. Comparing scopeDir
// against the *decoded* displayName is therefore unreliable and silently drops
// matches for any project whose directory name contains a hyphen. Instead,
// encode scopeDir the same way Claude encodes on disk and compare against the
// raw projectId — exact, since that's the ground truth Claude itself wrote.
// Other providers never derive a path-shaped displayName (cursor/codex/gemini
// group by id or a fixed label), so they fall back to the previous string
// comparison, which in practice never matches a filesystem scopeDir.
export function groupMatchesScopeDir(group: ProjectGroup, scopeDir: string): boolean {
  if (group.providerId === "claude") {
    const encoded = encodeProjectPath(scopeDir);
    return group.projectId === encoded || group.projectId.startsWith(`${encoded}-`);
  }
  return group.displayName === scopeDir || group.displayName.startsWith(scopeDir + path.sep);
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

// Structured "why did nothing upload?" payloads for the two empty-selection
// exits. Both used to print an identical, opaque "Nothing selected." — which
// read as a bug when the real cause was a `.frugl.json` scoping the run to a
// different project, or every session already being uploaded. Exported for
// unit tests; the command wraps `reason` in the standard JSON envelope.
export interface EmptySelectionReason {
  kind:
    | "no_providers_selected"
    | "no_sessions_discovered"
    | "outside_project_scope"
    | "nothing_left_after_filters";
  providersDetected?: string[];
  sessionsDiscovered?: number;
  projectsDiscovered?: number;
  alreadyUploaded?: number;
  trivialOrEmpty?: number;
  unselected?: number;
  scopeDir?: string;
  minCostUsd?: number;
}

export interface EmptySelectionExplanation {
  human: string;
  reason: EmptySelectionReason;
}

// The interactive provider picker ended with every provider unchecked. (The
// truly-nothing-detected machine never reaches this — it throws
// NoSessionsError during detection instead.)
export function explainNoProvidersSelected(
  supportedDetected: DetectedProvider[],
): EmptySelectionExplanation {
  const names = supportedDetected.map((d) => d.descriptor.displayName);
  return {
    human: `No providers selected — detected ${names.join(", ")}, but none were chosen in the picker. Nothing uploaded.`,
    reason: { kind: "no_providers_selected", providersDetected: names },
  };
}

// Providers (and possibly sessions) were discovered, but the final selection
// came out empty. Name the actual cause: no session files at all, everything
// outside the `.frugl.json` project scope, or everything filtered/deselected —
// with the counts the already-parsed classifications carry.
export function explainEmptySelection(input: {
  groups: ProjectGroup[];
  classifications: SessionClassification[];
  scopeDir: string | null;
  minCostUsd: number;
}): EmptySelectionExplanation {
  const sessionsDiscovered = input.groups.reduce((n, g) => n + g.sessionCount, 0);
  const projectsDiscovered = input.groups.length;
  const counts = {
    sessionsDiscovered,
    projectsDiscovered,
    minCostUsd: input.minCostUsd,
  };
  const found = `Found ${sessionsDiscovered} session${sessionsDiscovered === 1 ? "" : "s"} across ${projectsDiscovered} project${projectsDiscovered === 1 ? "" : "s"}`;

  if (sessionsDiscovered === 0) {
    return {
      human:
        "Found AI session sources, but no session files yet — nothing to upload. Use an AI coding tool for a bit, then run frugl upload again.",
      reason: { kind: "no_sessions_discovered", ...counts },
    };
  }

  // A `.frugl.json` scopes uploads to its own directory; every discovered
  // session belongs to some other project. The common real-world hit: running
  // a bare `frugl upload` from a freshly-`init`ed directory whose sessions
  // live under a different project path.
  if (input.scopeDir !== null) {
    return {
      human: `${found}, but none belong to this project — the .frugl.json at ${input.scopeDir} scopes uploads to it. Run frugl upload from the project the sessions belong to.`,
      reason: { kind: "outside_project_scope", ...counts, scopeDir: input.scopeDir },
    };
  }

  // Break the discovered set down by what removed each session from the
  // selection. `classifications` covers every discovered session on this path
  // (the interactive flow parses everything up front); whatever the buckets
  // don't explain was left unchecked in the picker.
  const buckets = bucketize(input.classifications);
  const alreadyUploaded = buckets.unchanged.length;
  const candidates = [...buckets.new, ...buckets.updated];
  const trivialOrEmpty =
    candidates.length - filterByCost(filterTrivial(candidates), EXCLUDE_FLOOR_USD).length;
  const unselected = Math.max(0, sessionsDiscovered - alreadyUploaded - trivialOrEmpty);
  const parts: string[] = [];
  if (alreadyUploaded > 0) parts.push(`${alreadyUploaded} already uploaded`);
  if (trivialOrEmpty > 0) parts.push(`${trivialOrEmpty} trivial or empty (under $0.01)`);
  if (unselected > 0) parts.push(`${unselected} left unselected in the picker`);
  return {
    human: `${found}, but none were selected${parts.length > 0 ? `: ${parts.join(", ")}` : ""}. Nothing new to upload.`,
    reason: {
      kind: "nothing_left_after_filters",
      ...counts,
      alreadyUploaded,
      trivialOrEmpty,
      unselected,
    },
  };
}

async function buildJobsForSource(
  items: SessionClassification[],
  source: Source,
  gitBySession: Map<string, GitContext>,
  // spec 054 — the full-upload threshold. A candidate at/above it uploads raw
  // ("full"); one below it (but >= the $0.01 floor) is "metadata", shipping its
  // metrics in the manifest with no raw body. `excluded` (< $0.01) candidates
  // never reach here — the selection drops them first.
  minCostUsd: number,
): Promise<SessionUploadJob[]> {
  const jobs: SessionUploadJob[] = [];
  // Memoized per batch: Cursor composer refs share one physical state.vscdb,
  // which would otherwise be re-read and re-hashed once per session.
  const rawHash = createRawFileHasher();
  for (const item of items) {
    if (item.kind === "unchanged") continue;
    const raw = await rawHash(item.ref.absolutePath);
    const gitContext = gitBySession.get(item.identity.sessionId);
    const worktreePath = extractWorktreePath(item.ref.absolutePath);
    const tier = classifyTier(
      computeSessionCostUSD(item.parsed.records, item.ref.sourceKind),
      minCostUsd,
    );
    // A tier of "excluded" can't occur for an item the selection passed through,
    // but guard anyway rather than silently ship an empty session.
    if (tier === "excluded") continue;
    jobs.push({
      sessionId: item.identity.sessionId,
      identityDerivation: item.identity.derivation,
      formatVersion: source.formatVersion,
      sourceFilePath: item.ref.absolutePath,
      mtimeMs: item.ref.mtimeMs,
      byteSizeOnDisk: item.ref.byteSizeOnDisk,
      anonymizationResult: item.anonymizationResult,
      rawContentHashAtFirstRun: raw,
      tier,
      ...(tier === "metadata"
        ? { metrics: computeSessionMetrics(item.parsed.records, item.ref.sourceKind) }
        : {}),
      ...(gitContext ? { gitContext } : {}),
      ...(worktreePath ? { worktreePath } : {}),
    });
  }
  return jobs;
}

// The lowest --min-cost we accept. Frugl exists to save you money, and parsing
// and shipping a session itself costs money — uploading cheap sessions is net
// negative, so we don't let the floor drop below this.
export const MIN_COST_FLOOR_USD = 10;

export function parseCostFlag(raw: string | undefined, flagName: string): number | undefined {
  if (raw === undefined) return undefined;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) {
    throw new UsageError(`${flagName} must be a non-negative number (e.g. 10, 25).`);
  }
  if (n < MIN_COST_FLOOR_USD) {
    throw new UsageError(
      `${flagName} must be at least $${MIN_COST_FLOOR_USD.toFixed(2)}. Frugl is about saving money — uploading sessions below that costs more to process than they're worth.`,
    );
  }
  return n;
}

const UPLOAD_TARGETS = ["sessions"] as const;

// `upload` ships AI coding sessions only; `sessions` is the sole positional
// target and is equivalent to passing nothing. Context snapshots belong to
// `frugl context`. Any other token is rejected so `upload context` fails loudly
// rather than silently doing nothing.
function resolveUploadTargets(positionals: string[]): { uploadSessions: boolean } {
  for (const raw of positionals) {
    if (!(UPLOAD_TARGETS as readonly string[]).includes(raw)) {
      throw new UsageError(
        `Unknown upload target '${raw}'. Valid target: ${UPLOAD_TARGETS.join(", ")} (omit to upload all sessions).`,
      );
    }
  }
  return { uploadSessions: true };
}
