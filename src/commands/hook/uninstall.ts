import { Command, Flags } from "@oclif/core";
import type { HookFsOptions, HookScope } from "../../hook/provider.js";
import { HOOK_PROVIDERS } from "../../hook/registry.js";
import { isFruglError, printFruglError } from "../../lib/errors.js";
import { resolveOutputMode, FORMAT_FLAG } from "../../lib/output-mode.js";
import { color, symbol } from "../../lib/theme.js";

export default class HookUninstall extends Command {
  static override description =
    "Remove the Frugl upload hook from every tool's config (Claude Code, Codex, Gemini, Cursor).";

  static override examples = [
    "<%= config.bin %> <%= command.id %>",
    "<%= config.bin %> <%= command.id %> --global",
  ];

  static override flags = {
    global: Flags.boolean({
      description: "Operate on the tools' user-level config instead of the project's.",
    }),
    format: FORMAT_FLAG,
  };

  async run(): Promise<void> {
    const { flags } = await this.parse(HookUninstall);
    const mode = resolveOutputMode({ format: flags.format });
    const scope: HookScope = flags.global ? "global" : "project";
    const homeDir = process.env["FRUGL_HOME_DIR"];
    const fsOpts: HookFsOptions = homeDir === undefined ? {} : { home: homeDir };

    try {
      // Sweep every provider regardless of detection — an uninstall should
      // remove our entries wherever a past install put them.
      const providers = HOOK_PROVIDERS.map((p) => {
        const effectiveScope: HookScope = p.supportsProjectScope ? scope : "global";
        const result = p.uninstall(effectiveScope, fsOpts);
        return { id: p.id, displayName: p.displayName, ...result };
      });

      if (mode === "json") {
        process.stdout.write(
          `${JSON.stringify({ command: "hook uninstall", ok: true, scope, providers })}\n`,
        );
        return;
      }
      const removed = providers.filter((p) => p.removed);
      for (const p of removed) {
        process.stdout.write(
          `${color.ok(`${symbol.tick} ${p.displayName}`)}  ${color.dim(`hook removed (${p.path})`)}\n`,
        );
      }
      if (removed.length === 0) {
        process.stdout.write(color.dim(`No Frugl hooks were installed (${scope}).\n`));
      }
    } catch (err) {
      if (isFruglError(err)) process.exit(printFruglError(err, mode));
      throw err;
    }
  }
}
