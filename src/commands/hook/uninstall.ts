import { Command, Flags } from "@oclif/core";
import { uninstallHook, type HookScope } from "../../hook/claude-code.js";
import { resolveOutputMode } from "../../lib/output-mode.js";
import { isPoppiError, printPoppiError } from "../../lib/errors.js";
import { color, symbol } from "../../lib/theme.js";

export default class HookUninstall extends Command {
  static override description = "Remove the Poppi upload hook from Claude Code settings.";

  static override flags = {
    global: Flags.boolean({
      description: "Operate on ~/.claude/settings.json instead of ./.claude/settings.json.",
    }),
    json: Flags.boolean({ description: "Emit machine-readable JSON output", default: false }),
  };

  async run(): Promise<void> {
    const { flags } = await this.parse(HookUninstall);
    const mode = resolveOutputMode({ json: flags.json });
    const scope: HookScope = flags.global ? "global" : "project";

    try {
      const { path: file, removed } = uninstallHook(scope);
      if (mode === "json") {
        process.stdout.write(
          `${JSON.stringify({ command: "hook uninstall", ok: true, path: file, removed, scope })}\n`,
        );
        return;
      }
      if (removed) {
        process.stdout.write(
          `${color.ok(`${symbol.tick} Removed Poppi hook`)}  ${color.dim(`(${scope}: ${file})`)}\n`,
        );
      } else {
        process.stdout.write(color.dim(`No Poppi hook was installed (${scope}).\n`));
      }
    } catch (err) {
      if (isPoppiError(err)) process.exit(printPoppiError(err, mode));
      throw err;
    }
  }
}
