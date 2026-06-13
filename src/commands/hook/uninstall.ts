import { Command, Flags } from "@oclif/core";
import { uninstallHook, type HookScope } from "../../hook/claude-code.js";
import { resolveOutputMode, FORMAT_FLAG } from "../../lib/output-mode.js";
import { isFruglError, printFruglError } from "../../lib/errors.js";
import { color, symbol } from "../../lib/theme.js";

export default class HookUninstall extends Command {
  static override description = "Remove the Frugl upload hook from Claude Code settings.";

  static override flags = {
    global: Flags.boolean({
      description: "Operate on ~/.claude/settings.json instead of ./.claude/settings.json.",
    }),
    format: FORMAT_FLAG,
  };

  async run(): Promise<void> {
    const { flags } = await this.parse(HookUninstall);
    const mode = resolveOutputMode({ format: flags.format });
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
          `${color.ok(`${symbol.tick} Removed Frugl hook`)}  ${color.dim(`(${scope}: ${file})`)}\n`,
        );
      } else {
        process.stdout.write(color.dim(`No Frugl hook was installed (${scope}).\n`));
      }
    } catch (err) {
      if (isFruglError(err)) process.exit(printFruglError(err, mode));
      throw err;
    }
  }
}
