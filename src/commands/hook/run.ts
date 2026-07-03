import { Command } from "@oclif/core";
import { executeHookRun } from "../../hook/run.js";
import { COMMON_FLAGS } from "../../lib/command-context.js";
import { isFruglError, printFruglError } from "../../lib/errors.js";
import { resolveOutputMode } from "../../lib/output-mode.js";

export default class HookRun extends Command {
  static override description =
    "Preflight and detach a background upload — the command session hooks invoke. " +
    "Exits 0 immediately: silently when not logged in (or a recent/blocked run made " +
    "an upload pointless), otherwise after spawning 'frugl upload' detached.";

  static override examples = ["<%= config.bin %> <%= command.id %>"];

  // Codex's notify appends a JSON payload as a positional argument; other tools
  // pipe payloads via stdin. Accept and ignore both.
  static override strict = false;

  static override flags = { ...COMMON_FLAGS };

  async run(): Promise<void> {
    const { flags } = await this.parse(HookRun);
    const mode = resolveOutputMode({ format: flags.format });
    try {
      const result = await executeHookRun({ flagEndpoint: flags.endpoint });
      if (mode === "json") {
        process.stdout.write(`${JSON.stringify({ command: "hook run", ok: true, ...result })}\n`);
      }
      // Text modes stay silent: hook runners capture output, and there is no
      // human watching a background trigger.
    } catch (err) {
      if (isFruglError(err)) process.exit(printFruglError(err, mode));
      throw err;
    }
  }
}
