import { Command, Flags } from "@oclif/core";
import { isInstalled, settingsPath, type HookScope } from "../../hook/claude-code.js";
import { resolveOutputMode } from "../../lib/output-mode.js";
import { color, symbol } from "../../lib/theme.js";

export default class HookStatus extends Command {
  static override description = "Report whether the Frugl upload hook is installed in Claude Code.";

  static override flags = {
    global: Flags.boolean({
      description: "Check ~/.claude/settings.json instead of ./.claude/settings.json.",
    }),
    json: Flags.boolean({ description: "Emit machine-readable JSON output", default: false }),
  };

  async run(): Promise<void> {
    const { flags } = await this.parse(HookStatus);
    const mode = resolveOutputMode({ json: flags.json });
    const scope: HookScope = flags.global ? "global" : "project";
    const file = settingsPath(scope);
    const installed = isInstalled(scope);

    if (mode === "json") {
      process.stdout.write(
        `${JSON.stringify({ command: "hook status", ok: true, installed, path: file, scope })}\n`,
      );
      return;
    }
    process.stdout.write(
      installed
        ? `${color.ok(`${symbol.tick} Frugl hook installed`)}  ${color.dim(`(${scope}: ${file})`)}\n`
        : `${color.dim(`No Frugl hook installed (${scope}: ${file}).`)}\n`,
    );
  }
}
