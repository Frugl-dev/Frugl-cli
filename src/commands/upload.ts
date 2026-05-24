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
import { buildUploadSummary, formatSummaryForHuman } from "../upload/summary.js";
import { createProgressReporter } from "../upload/progress.js";
import { runUploadPipeline, rawFileHash, type SessionUploadJob } from "../upload/pipeline.js";
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
    json: Flags.boolean({ description: "Emit machine-readable JSON output", default: false }),
  };

  async run(): Promise<void> {
    const { flags } = await this.parse(Upload);
    const mode = resolveOutputMode({ json: flags.json });
    const reporter = createProgressReporter(mode);

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

      const refs = await claudeCodeSource.discover();
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

      const summary = buildUploadSummary({
        buckets,
        willUpload,
        policyVersion: POLICY_VERSION,
        endpoint,
        sourceKind: claudeCodeSource.kind,
        ...(flags.limit !== undefined ? { limit: flags.limit } : {}),
      });

      if (mode === "text") {
        process.stdout.write(`${formatSummaryForHuman(summary)}\n`);
      }

      if (flags["dry-run"]) {
        if (flags.inspect) {
          await writeInspectionDir(flags.inspect, !!flags.force, willUpload, summary);
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

      const jobs = await buildJobs(willUpload);
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
}

async function buildJobs(items: SessionClassification[]): Promise<SessionUploadJob[]> {
  const jobs: SessionUploadJob[] = [];
  for (const item of items) {
    if (item.kind === "unchanged") continue;
    const raw = await rawFileHash(item.ref.absolutePath);
    jobs.push({
      sessionId: item.identity.sessionId,
      identityDerivation: item.identity.derivation,
      formatVersion: CLAUDE_FORMAT_VERSION,
      sourceFilePath: item.ref.absolutePath,
      anonymizationResult: item.anonymizationResult,
      rawContentHashAtFirstRun: raw,
    });
  }
  return jobs;
}

async function writeInspectionDir(
  dir: string,
  force: boolean,
  items: SessionClassification[],
  summary: ReturnType<typeof buildUploadSummary>,
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
}

function filterPositive<T extends Record<string, number>>(obj: T): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v > 0) out[k] = v;
  }
  return out;
}
