import { Command, Flags } from "@oclif/core";
import { SessionStore } from "../../auth/session-store.js";
import { resolveEndpoint } from "../../cloud/endpoints.js";
import { HOOK_RUN_COMMAND, type HookFsOptions, type HookScope } from "../../hook/provider.js";
import { HOOK_PROVIDER_IDS, HOOK_PROVIDERS } from "../../hook/registry.js";
import { isFruglError, printFruglError } from "../../lib/errors.js";
import { resolveOutputMode, FORMAT_FLAG } from "../../lib/output-mode.js";
import { color, symbol } from "../../lib/theme.js";

interface ProviderOutcome {
  id: string;
  displayName: string;
  status: "installed" | "skipped" | "conflict";
  path: string;
  reason?: string;
}

export default class HookInstall extends Command {
  static override description =
    "Install session hooks that run a headless Frugl upload when an AI coding session ends. " +
    "Wires every detected tool (Claude Code, Codex, Gemini, Cursor) unless --providers narrows it.";

  static override examples = [
    "<%= config.bin %> <%= command.id %>                      # this project, detected tools",
    "<%= config.bin %> <%= command.id %> --global             # whole machine",
    "<%= config.bin %> <%= command.id %> --providers claude,cursor",
  ];

  static override flags = {
    global: Flags.boolean({
      description: "Write the tools' user-level config (e.g. ~/.claude) instead of the project's.",
    }),
    providers: Flags.string({
      description:
        "Comma-separated tools to wire up (claude, codex, gemini, cursor). " +
        "Defaults to every tool detected on this machine; naming one installs it even if undetected.",
      multiple: true,
      delimiter: ",",
      options: HOOK_PROVIDER_IDS,
    }),
    format: FORMAT_FLAG,
  };

  async run(): Promise<void> {
    const { flags } = await this.parse(HookInstall);
    const mode = resolveOutputMode({ format: flags.format });
    const scope: HookScope = flags.global ? "global" : "project";
    // FRUGL_HOME_DIR mirrors the session-discovery override so tests (and the
    // curious) can point the whole feature at a fixture home.
    const homeDir = process.env["FRUGL_HOME_DIR"];
    const fsOpts: HookFsOptions = homeDir === undefined ? {} : { home: homeDir };
    const requested = flags.providers;

    try {
      const outcomes: ProviderOutcome[] = [];
      for (const provider of HOOK_PROVIDERS) {
        const explicit = requested !== undefined;
        if (explicit && !requested.includes(provider.id)) continue;
        const base = { id: provider.id, displayName: provider.displayName };
        if (scope === "project" && !provider.supportsProjectScope) {
          outcomes.push({
            ...base,
            status: "skipped",
            path: provider.configPath("global", fsOpts),
            reason: `${provider.displayName} config is machine-global — rerun with --global`,
          });
          continue;
        }
        // Detection gates the default set only; asking for a tool by name
        // installs its hook even before the tool's first run.
        if (!explicit && !provider.detect(fsOpts)) {
          outcomes.push({
            ...base,
            status: "skipped",
            path: provider.configPath(scope, fsOpts),
            reason: "not detected on this machine",
          });
          continue;
        }
        const result = provider.install(scope, fsOpts);
        outcomes.push({ ...base, ...result });
      }

      // Warn (don't fail) when no headless token is configured — the hooks
      // would otherwise no-op silently when they fire.
      const endpoint = resolveEndpoint({ env: process.env["FRUGL_ENDPOINT"] });
      const tokenConfigured =
        (await new SessionStore().resolveToken({ endpointUrl: endpoint.url })) !== null;

      if (mode === "json") {
        process.stdout.write(
          `${JSON.stringify({
            command: "hook install",
            ok: true,
            scope,
            hookCommand: HOOK_RUN_COMMAND,
            tokenConfigured,
            providers: outcomes,
          })}\n`,
        );
        return;
      }

      for (const o of outcomes) {
        if (o.status === "installed") {
          process.stdout.write(
            `${color.ok(`${symbol.tick} ${o.displayName}`)}  ${color.dim(`hook installed (${o.path})`)}\n`,
          );
        } else if (o.status === "conflict") {
          process.stdout.write(
            `${color.warn(`${symbol.warn} ${o.displayName}`)}  ${color.dim(`${o.reason} (${o.path})`)}\n`,
          );
        } else {
          process.stdout.write(`${color.dim(`- ${o.displayName}  skipped — ${o.reason}`)}\n`);
        }
      }
      const installed = outcomes.filter((o) => o.status === "installed");
      if (installed.length > 0) {
        process.stdout.write(
          `${color.dim("  Runs on session end: ")}${color.frog(HOOK_RUN_COMMAND)}\n`,
        );
      }
      if (!tokenConfigured) {
        process.stderr.write(
          `${color.warn(`${symbol.warn} Not logged in.`)} ${color.dim(
            "The hooks stay dormant until you run 'frugl login' (or set FRUGL_TOKEN) — nothing uploads before then.",
          )}\n`,
        );
      }
    } catch (err) {
      if (isFruglError(err)) process.exit(printFruglError(err, mode));
      throw err;
    }
  }
}
