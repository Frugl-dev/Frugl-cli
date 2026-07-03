import { Command, Flags } from "@oclif/core";
import type { HookFsOptions, HookScope } from "../../hook/provider.js";
import { HOOK_PROVIDERS } from "../../hook/registry.js";
import { resolveOutputMode, FORMAT_FLAG } from "../../lib/output-mode.js";
import { color, symbol } from "../../lib/theme.js";

export default class HookStatus extends Command {
  static override description =
    "Report which tools (Claude Code, Codex, Gemini, Cursor) have the Frugl upload hook installed.";

  static override examples = [
    "<%= config.bin %> <%= command.id %>",
    "<%= config.bin %> <%= command.id %> --global",
  ];

  static override flags = {
    global: Flags.boolean({
      description: "Check the tools' user-level config instead of the project's.",
    }),
    format: FORMAT_FLAG,
  };

  async run(): Promise<void> {
    const { flags } = await this.parse(HookStatus);
    const mode = resolveOutputMode({ format: flags.format });
    const scope: HookScope = flags.global ? "global" : "project";
    const homeDir = process.env["FRUGL_HOME_DIR"];
    const fsOpts: HookFsOptions = homeDir === undefined ? {} : { home: homeDir };

    const providers = HOOK_PROVIDERS.map((p) => {
      // Codex has no project-scoped config; report its (only) global state.
      const effectiveScope: HookScope = p.supportsProjectScope ? scope : "global";
      return {
        id: p.id,
        displayName: p.displayName,
        detected: p.detect(fsOpts),
        installed: p.isInstalled(effectiveScope, fsOpts),
        path: p.configPath(effectiveScope, fsOpts),
      };
    });

    if (mode === "json") {
      process.stdout.write(
        `${JSON.stringify({ command: "hook status", ok: true, scope, providers })}\n`,
      );
      return;
    }
    for (const p of providers) {
      if (p.installed) {
        process.stdout.write(
          `${color.ok(`${symbol.tick} ${p.displayName}`)}  ${color.dim(`installed (${p.path})`)}\n`,
        );
      } else {
        const note = p.detected ? "not installed" : "not detected";
        process.stdout.write(`${color.dim(`- ${p.displayName}  ${note} (${p.path})`)}\n`);
      }
    }
  }
}
