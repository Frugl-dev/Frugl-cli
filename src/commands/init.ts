import { Command, Flags } from "@oclif/core";
import { confirm } from "@inquirer/prompts";
import { join } from "node:path";
import { buildCommandContext, COMMON_FLAGS, handleCommandError } from "../lib/command-context.js";
import { color } from "../lib/theme.js";
import { runAuthAndOrgSetup } from "../org/onboard.js";
import {
  PROJECT_CONFIG_FILENAME,
  readMergeableConfig,
  writeProjectConfig,
  type ProjectConfig,
} from "../config/project-config.js";
import { MIN_COST_FLOOR_USD, parseCostFlag } from "./upload.js";

// Managed values `init` writes whose change we warn about before overwriting an
// existing, conflicting value (FR-009). Compares the about-to-write patch
// against the file already on disk; only a DIFFERENT existing value counts —
// adding a key the file doesn't have yet is never a conflict.
function findConflicts(
  existing: Record<string, unknown> | null,
  patch: Partial<ProjectConfig>,
): string[] {
  if (!existing) return [];
  const conflicts: string[] = [];
  if (
    patch.org !== undefined &&
    typeof existing["org"] === "string" &&
    existing["org"] !== patch.org
  ) {
    conflicts.push("org");
  }
  if (
    patch.endpoint !== undefined &&
    typeof existing["endpoint"] === "string" &&
    existing["endpoint"] !== patch.endpoint
  ) {
    conflicts.push("endpoint");
  }
  const existingUpload = existing["upload"];
  const existingUploadObj =
    typeof existingUpload === "object" && existingUpload !== null
      ? (existingUpload as Record<string, unknown>)
      : undefined;
  const existingMin = existingUploadObj?.["minCost"];
  if (
    patch.upload?.minCost !== undefined &&
    typeof existingMin === "number" &&
    existingMin !== patch.upload.minCost
  ) {
    conflicts.push("upload.minCost");
  }
  return conflicts;
}

export default class Init extends Command {
  static override description = `One-command onboarding: sign in, set up an org, write a project-local .frugl.json, then run the first upload and snapshot.

Writes a committable .frugl.json (endpoint pin only for self-host, org, and any
non-default upload options — never a secret) so later 'frugl upload' / 'frugl
snapshot' runs in this directory are deterministic.

Exit codes:
  0   success
  2   usage error (bad flags / missing non-interactive input)
 10   not authenticated — run: frugl login
 20   no sessions found
 30   anonymization failure
 40   network error`;

  static override examples = [
    "<%= config.bin %> <%= command.id %>                                  # interactive: sign in, create/join an org, upload + snapshot",
    "<%= config.bin %> <%= command.id %> --github                        # sign in with GitHub in the browser",
    '<%= config.bin %> <%= command.id %> --yes --org-name "Acme"          # non-interactive (auth via a prior login or FRUGL_TOKEN)',
    "<%= config.bin %> <%= command.id %> --no-upload --no-snapshot        # just write .frugl.json",
  ];

  static override flags = {
    yes: Flags.boolean({
      char: "y",
      description:
        "Run non-interactively: no prompts, defaults accepted, missing input fails fast.",
    }),
    email: Flags.string({ description: "Email address to sign in with" }),
    google: Flags.boolean({
      description: "Sign in with Google (opens browser).",
      exclusive: ["github"],
    }),
    github: Flags.boolean({
      description: "Sign in with GitHub (opens browser).",
      exclusive: ["google"],
    }),
    "org-name": Flags.string({ description: "Organization name to create (skips the prompt)" }),
    "invite-code": Flags.string({ description: "Invite code to join an existing org" }),
    "min-cost": Flags.string({
      description:
        "Skip sessions whose estimated cost is below this amount in USD. Default and minimum 10.00.",
    }),
    upload: Flags.boolean({
      allowNo: true,
      default: true,
      description: "Run the first upload as part of init (--no-upload to skip).",
    }),
    snapshot: Flags.boolean({
      allowNo: true,
      default: true,
      description: "Capture a context + MCP snapshot as part of init (--no-snapshot to skip).",
    }),
    force: Flags.boolean({
      description: "Overwrite a conflicting .frugl.json value without prompting.",
    }),
    ...COMMON_FLAGS,
  };

  async run(): Promise<void> {
    const { flags } = await this.parse(Init);
    const { mode, endpoint, client, session } = await buildCommandContext(flags, {
      auth: "optional",
    });

    try {
      // Validate --min-cost up front so a bad value fails fast (exit 2) before
      // the login flow. parseCostFlag floors at $10 and returns undefined when
      // the flag is absent (then the upload step uses its own default).
      const minCost = parseCostFlag(flags["min-cost"], "--min-cost");

      // Step 1+2: shared auth + org setup (FR-002, FR-003).
      const { orgResult } = await runAuthAndOrgSetup({
        endpoint,
        client,
        mode,
        existingSession: session,
        flags: {
          email: flags.email,
          google: flags.google,
          github: flags.github,
          orgName: flags["org-name"],
          inviteCode: flags["invite-code"],
          yes: flags.yes,
        },
        command: "init",
      });

      // Step 3: write .frugl.json (FR-007). `org` is the resolved slug; the
      // endpoint is pinned ONLY when it's non-default (a real self-host target)
      // so a cloud user is never locked to a stale endpoint; minCost is recorded
      // only when explicitly customized away from the default. No project-scope
      // field is written: a `.frugl.json`'s mere presence in this directory IS
      // the scope declaration — later `frugl upload` / `frugl snapshot` runs
      // here (and in anything nested under it, e.g. worktrees) already discover
      // it without a glob. Deliberately not `upload.auto: true`: that also skips
      // the confirmation prompt on every future `frugl upload` and makes upload
      // re-trigger its own snapshot pass, neither of which this one-time write
      // implies.
      const dir = process.cwd();
      const patch: Partial<ProjectConfig> = {
        org: orgResult.slug,
        ...(endpoint.resolvedFrom !== "default" ? { endpoint: endpoint.url } : {}),
        ...(minCost !== undefined && minCost !== MIN_COST_FLOOR_USD ? { upload: { minCost } } : {}),
      };

      let wrote: { path: string; changed: boolean } | null = null;
      const existing = readMergeableConfig(join(dir, PROJECT_CONFIG_FILENAME));
      const conflicts = findConflicts(existing, patch);
      let overwrite = true;
      if (conflicts.length > 0 && !flags.yes && !flags.force) {
        // Interactive guard (FR-009): never silently clobber a hand-edited value.
        overwrite = await confirm({
          message: `${PROJECT_CONFIG_FILENAME} already sets ${conflicts.join(", ")} differently. Overwrite?`,
          default: false,
        });
      }

      if (overwrite) {
        wrote = writeProjectConfig(patch, { dir, force: flags.force });
        if (mode !== "json") {
          const verb = wrote.changed ? "Wrote" : "Up to date";
          process.stdout.write(`${color.dim(`  ${verb}: `)}${color.frog(wrote.path)}\n`);
        }
      } else if (mode !== "json") {
        process.stdout.write(
          color.dim(`  Kept existing ${PROJECT_CONFIG_FILENAME} (declined overwrite).\n`),
        );
      }

      // Steps 4+5: run the real upload and snapshot commands via oclif so init
      // reuses their exact pipelines (FR-015: a failure here is reported by the
      // subcommand and exits — but the .frugl.json above is already written and
      // is not undone). --endpoint is threaded explicitly because `upload`
      // resolves its endpoint from flag/env only, not the freshly-written pin.
      const passthrough: string[] = ["--endpoint", endpoint.url];
      if (flags.format) passthrough.push("--format", flags.format);

      if (flags.upload) {
        const uploadArgv = [...passthrough];
        if (flags.yes) uploadArgv.push("--yes");
        if (flags["min-cost"]) uploadArgv.push("--min-cost", flags["min-cost"]);
        await this.config.runCommand("upload", uploadArgv);
      }

      if (flags.snapshot) {
        await this.config.runCommand("snapshot", [...passthrough]);
      }

      // Step 6: the payoff — where to look next.
      const dashboardUrl = `${endpoint.url}/dashboard`;
      if (mode === "json") {
        process.stdout.write(
          `${JSON.stringify({
            command: "init",
            ok: true,
            org: orgResult.slug,
            endpoint: endpoint.url,
            configPath: wrote?.path ?? join(dir, PROJECT_CONFIG_FILENAME),
            configChanged: wrote?.changed ?? false,
            dashboardUrl,
          })}\n`,
        );
      } else {
        process.stdout.write(
          `\n  ${color.dim("Dashboard: ")}${color.frog(color.underline(dashboardUrl))}\n`,
        );
      }
    } catch (err) {
      handleCommandError(err, mode);
    }
  }
}
