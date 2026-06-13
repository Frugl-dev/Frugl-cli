import { Args, Command, Flags } from "@oclif/core";
import { confirm } from "@inquirer/prompts";
import { mkdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { color, formatBytes, symbol, SIGIL } from "../lib/theme.js";
import { randomUUID } from "node:crypto";
import { CloudClient, CloudHttpError } from "../cloud/client.js";
import { resolveEndpoint } from "../cloud/endpoints.js";
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
  rawFileHash,
  type SessionUploadJob,
} from "../upload/pipeline.js";
import { captureDeclaredMcpServers } from "../capture/claude/mcp-inventory.js";
import { captureContext } from "../context/capture.js";
import { uploadContextSnapshot } from "../context/upload.js";
import { HttpCloudAdapter } from "../upload/cloud-http-adapter.js";
import { requestHandoffUrl, resolveHandoffPreference } from "../cloud/handoff.js";
import { resolveGitContext, type GitContext } from "../upload/git-context.js";
import { extractWorktreePath } from "../sources/claude-code/project.js";
import {
  detectProviders,
  getProvider,
  getSourceByKind,
  type DetectedProvider,
  type ProjectGroup,
} from "../sources/providers.js";
import { applySelection, isInteractive, selectProjects, selectProviders } from "../select/index.js";
import type { Selection } from "../select/selection.js";
import type { Source, SessionRef } from "../sources/types.js";
import { anonymize, POLICY_VERSION } from "../anonymize/index.js";
import {
  AuthError,
  InspectDirError,
  NoSessionsError,
  printFruglError,
  StaleResumeError,
  UsageError,
} from "../lib/errors.js";
import { EXIT } from "../lib/exit-codes.js";
import { getCliVersion } from "../lib/cli-version.js";
import { getLinkPrs } from "../lib/config.js";
import { loadUploadConfig, resolveConfigSelection } from "../config/upload-config.js";
import { resolveDebug, resolveOutputMode, type OutputMode } from "../lib/output-mode.js";

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
 60   --inspect dir already exists

Set FRUGL_DEBUG=1 to print HTTP request/response lines to stderr.`;

  static override args = {
    manifestId: Args.string({
      description: "With --report: the manifest to explain (defaults to the in-flight upload).",
      required: false,
    }),
  };

  static override flags = {
    yes: Flags.boolean({ description: "Skip the interactive confirmation prompt." }),
    "dry-run": Flags.boolean({ description: "Anonymize but do not transmit." }),
    inspect: Flags.string({
      description: "With --dry-run: write redacted output to a local inspection dir.",
    }),
    force: Flags.boolean({ description: "Overwrite existing --inspect dir." }),
    endpoint: Flags.string({ description: "Override the API endpoint." }),
    token: Flags.string({
      description:
        "Access token for non-interactive auth (CI / hooks). Overrides FRUGL_TOKEN and any stored login.",
    }),
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
    "link-prs": Flags.boolean({
      description:
        "Opt in to attaching credential-stripped git context (repo, branch, commit) so sessions can be linked to PRs. Default off.",
    }),
    handoff: Flags.boolean({
      // No default: `undefined` means "not passed", so the interactive-TTY
      // default in resolveHandoffPreference stays detectable (research R-5).
      allowNo: true,
      description:
        "Append a single-use, short-lived sign-in code to the printed dashboard link so the browser lands signed in (--no-handoff to disable). Default: on for interactive runs, off for --json / non-TTY / CI.",
    }),
    json: Flags.boolean({ description: "Emit machine-readable JSON output", default: false }),
    report: Flags.boolean({
      description:
        "Explain the last upload's failures (grouped by reason, with remedies) instead of uploading.",
      default: false,
    }),
    sessions: Flags.boolean({
      description:
        "Upload AI coding sessions. When neither --sessions nor --context is given, both are uploaded.",
    }),
    context: Flags.boolean({
      description:
        "Capture and upload a Claude Code context snapshot. When neither --sessions nor --context is given, both are uploaded.",
    }),
  };

  async run(): Promise<void> {
    const { flags, args } = await this.parse(Upload);
    const mode = resolveOutputMode({ json: flags.json });
    const reporter = createProgressReporter(mode);

    const neither = !flags.sessions && !flags.context;
    const uploadSessions = flags.sessions || neither;
    const uploadContext = flags.context || neither;

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

    if (flags.inspect && !flags["dry-run"]) {
      this.bail(new UsageError("--inspect requires --dry-run."), mode);
    }
    if (flags.limit !== undefined && flags.limit <= 0) {
      this.bail(new UsageError("--limit must be a positive integer."), mode);
    }

    const endpoint = resolveEndpoint({
      flag: flags.endpoint,
      env: process.env["FRUGL_ENDPOINT"],
    });
    try {
      // Fail-closed: a malformed/unreadable config throws here -> bail -> exit 2.
      const uploadConfig = loadUploadConfig({ explicitPath: flags.config });
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
          cliVersion: getCliVersion(),
        }),
      });
      const session = await auth.resolveRequestAuth({ flagToken: flags.token });
      const client = new CloudClient({
        endpointUrl: endpoint.url,
        cliVersion: getCliVersion(),
        token: session.token,
        endpointExplicit: endpoint.resolvedFrom !== "default",
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
          requestedManifestId: args.manifestId,
          mode,
        });
      }

      // Shared accumulators — set inside the sessions block, read by the context
      // block and the final output section.
      let totalAcked = 0;
      let lastManifestId = "";
      let lastDashboardUrl = `${endpoint.url}/dashboard`;
      let contextUploadResult:
        | { manifestId: string; sessionId: string; capturedAt: string; byteSize: number }
        | undefined;

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

        if (mode === "text")
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
          json: flags.json,
          yes: flags.yes,
          isTTY: Boolean(process.stdin.isTTY),
        });

        const groups: ProjectGroup[] = [];
        let selection: Selection;

        if (uploadConfig) {
          // Config-driven scope: derive all supported providers' projects, then
          // filter by the config's providers + project include/exclude globs.
          for (const d of supportedDetected) {
            const descriptor = getProvider(d.descriptor.id);
            if (!descriptor?.supported || !descriptor.source || !descriptor.deriveProjects)
              continue;
            const providerRefs = await descriptor.source.discover(discoverOpts);
            groups.push(...descriptor.deriveProjects(providerRefs));
          }
          selection = resolveConfigSelection(uploadConfig, detected, groups);
        } else {
          // 2) Choose providers — interactive picker, or auto-select-all when not.
          const selectedProviderIds = await selectProviders(detected, { interactive });
          if (selectedProviderIds.length === 0) {
            if (mode === "text") process.stderr.write(color.dim("Nothing selected.\n"));
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
          // 4) Choose projects — all preselected; deselect to exclude from upload.
          const selectedProjectIds = await selectProjects(groups, { interactive });
          selection = { providerIds: selectedProviderIds, projectIds: selectedProjectIds };
        }
        selectionReport = buildSelectionReport(detected, groups, selection);

        const refs = applySelection(groups, selection);
        if (refs.length === 0) {
          if (mode === "text") process.stderr.write(color.dim("Nothing selected.\n"));
          process.exit(EXIT.OK);
        }

        const uploadId = randomUUID();
        // Group refs by source for per-source pipeline
        const refsBySource = new Map<Source, SessionRef[]>();
        for (const ref of refs) {
          const source = getSourceByKind(ref.sourceKind);
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
          const sorted = sourceRefs.toSorted(
            (a, b) => b.mtimeMs - a.mtimeMs || a.absolutePath.localeCompare(b.absolutePath),
          );
          const homeDirOverride = process.env["FRUGL_HOME_DIR"];
          const classifications = await classifyAll(sorted, {
            ledger,
            source,
            anonymize: {
              uploadId,
              ownerEmail: session.email,
              ...(homeDirOverride !== undefined ? { homeDir: homeDirOverride } : {}),
            },
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
        willUpload =
          flags.limit !== undefined ? allCandidates.slice(0, flags.limit) : allCandidates;

        const activeSources = [...refsBySource.keys()];
        displaySourceKind = activeSources.length === 1 ? activeSources[0]!.kind : "multi";

        // Opt-in git-context resolution: only run the (expensive) git pass when
        // linking is active. The builder folds in the link-prs precedence and
        // assembles the `prLinking` summary from these raw git facts.
        const gitBySession = new Map<string, GitContext>();
        let gitContext: { sessionsWithContext: number; repositories: string[] } | undefined;
        if (linkActive) {
          const repositories = await this.resolveBatchGitContext(willUpload, gitBySession);
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
        });
        prLinking = summary.prLinking;

        if (mode === "text") {
          process.stdout.write(`${formatSummaryForHuman(summary)}\n`);
        }

        if (flags["dry-run"]) {
          if (flags.inspect) {
            await writeInspectionDir(
              flags.inspect,
              !!flags.force,
              willUpload,
              summary,
              gitBySession,
            );
          }
          if (mode === "text") {
            process.stdout.write(
              `\n${color.dim("Dry-run — anonymized, nothing transmitted.")}  ${color.bold("0 bytes sent.")}\n`,
            );
            if (flags.inspect) {
              process.stdout.write(
                `${color.ok(`${symbol.tick} Wrote ${flags.inspect}/`)}  ${color.dim("review with ")}${color.frog("jq .")}${color.dim(" before transmitting.")}\n`,
              );
            } else {
              process.stdout.write(
                `${color.dim("  Tip: add ")}${color.frog("--inspect ./out")}${color.dim(" to write the redacted payloads to disk and audit them.")}\n`,
              );
            }
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
          const finalized = await finalizePendingManifest({ cloud, resumeStore });
          if (finalized) {
            lastManifestId = finalized.manifestId;
            lastDashboardUrl = finalized.dashboardUrl;
            if (mode === "text") {
              process.stderr.write(color.dim("Completed a previously interrupted upload batch.\n"));
            }
          }
        } catch {
          // Completion is still failing transiently; the state is kept and the
          // next run will retry. Never block this run's work on it.
        }

        if (willUpload.length === 0) {
          if (!uploadContext) {
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
            if (mode === "text") {
              process.stdout.write(
                `${color.dim("No new or updated sessions. Nothing to upload.")}\n`,
              );
            }
            if (mode === "json") process.stdout.write(`${JSON.stringify(result)}\n`);
            return;
          }
          if (mode === "text") {
            process.stdout.write(`${color.dim("No new or updated sessions.")}\n`);
          }
        }

        if (willUpload.length > 0) {
          if (!flags.yes) {
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

            const jobs = await buildJobsForSource(sourceCandidates, source, gitBySession);
            const gitContextEvent = prLinking
              ? {
                  active: true,
                  sessionsWithContext: prLinking.sessionsWithContext,
                  repositories: prLinking.repositories,
                }
              : undefined;

            // Declared MCP inventory (names-only, fail-open): `claude mcp list` is
            // Claude Code's vocabulary, so only that source's manifest carries it.
            const mcpServers =
              source.kind === "claude-code" ? captureDeclaredMcpServers() : undefined;

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
                if (mode === "text") {
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

      // Context snapshot upload — runs after sessions (or alone with --context).
      if (uploadContext && !flags["dry-run"]) {
        if (mode === "text")
          process.stderr.write(
            color.dim("Snapshotting your context window — redacting locally…\n"),
          );
        const ctxHomeDir = process.env["FRUGL_HOME_DIR"];
        const capture = captureContext("claude-code");
        // Local-only random salt. The pseudonym HMAC key must never equal a
        // value that ships in the manifest (capturedAt does), or pseudonyms
        // become dictionary-reversible by anyone holding the payload.
        const ctxAnon = anonymize(capture.text, {
          uploadId: randomUUID(),
          ownerEmail: session.email,
          ...(ctxHomeDir !== undefined ? { homeDir: ctxHomeDir } : {}),
        });
        const ctxMcpServers = captureDeclaredMcpServers();
        const ctxUpload = await uploadContextSnapshot({
          cloud,
          cliVersion: getCliVersion(),
          sourceKind: "claude-code",
          policyVersion: POLICY_VERSION,
          capturedAt: capture.capturedAt,
          anonymization: ctxAnon,
          ...(ctxMcpServers ? { mcpServers: ctxMcpServers } : {}),
        });
        contextUploadResult = {
          manifestId: ctxUpload.manifestId,
          sessionId: ctxUpload.sessionId,
          capturedAt: capture.capturedAt,
          byteSize: ctxAnon.byteSize,
        };
        if (lastDashboardUrl === `${endpoint.url}/dashboard`) {
          lastDashboardUrl = ctxUpload.dashboardUrl;
        }
        if (mode === "text") {
          process.stdout.write(
            `${color.ok(`${symbol.tick} Context snapshot captured`)} ${color.dim(`at ${capture.capturedAt}`)}\n`,
          );
        }
      }

      // The payoff. The one place upload lets itself celebrate — a receipt that
      // makes the redaction story tangible: what was scrubbed on your machine,
      // what actually left it, and the number that matters (0 raw secrets sent).
      if (uploadSessions && totalAcked > 0 && mode === "text") {
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
        process.stdout.write(
          `\n  ${color.dim("→ run ")}${color.frog("frugl recs")}${color.dim(" to see what's worth fixing.")}\n`,
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
      if (mode === "text") {
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

      // Context-only path: emit a compact JSON output and exit.
      if (!uploadSessions && contextUploadResult !== undefined) {
        if (mode === "json") {
          process.stdout.write(
            `${JSON.stringify({
              command: "upload" as const,
              ok: true as const,
              endpoint: endpoint.url,
              dashboardUrl: handoff.dashboardUrl,
              ...(handoff.active
                ? { handoff: { active: true as const, expiresAt: handoff.expiresAt } }
                : handoff.reason === "disabled-default"
                  ? {}
                  : { handoff: { active: false as const, reason: handoff.reason } }),
              context: contextUploadResult,
            })}\n`,
          );
        }
        return;
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
        ...(contextUploadResult ? { context: contextUploadResult } : {}),
      };
      if (mode === "json") process.stdout.write(`${JSON.stringify(finalSummary)}\n`);
    } catch (err) {
      this.bail(err, mode);
    }
  }

  private bail(err: unknown, mode: OutputMode = "text"): never {
    if (
      err instanceof CloudHttpError &&
      err.status === 409 &&
      (err.body as Record<string, unknown>)?.error === "org_required"
    ) {
      if (mode === "text") {
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
    if (err instanceof AuthError && mode === "text") {
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
    if (err instanceof NoSessionsError && mode === "text" && !err.message.includes("supported")) {
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
