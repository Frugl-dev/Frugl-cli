import { Command, Flags } from "@oclif/core";
import { installHook, type HookScope } from "../../hook/claude-code.js";
import { resolveHeadlessToken } from "../../auth/token-auth.js";
import { resolveEndpoint } from "../../cloud/endpoints.js";
import { resolveOutputMode } from "../../lib/output-mode.js";
import { isFruglError, printFruglError } from "../../lib/errors.js";
import { color, symbol } from "../../lib/theme.js";

export default class HookInstall extends Command {
  static override description =
    "Install a Claude Code hook that runs a headless Frugl upload when a session ends.";

  static override flags = {
    global: Flags.boolean({
      description: "Write ~/.claude/settings.json instead of ./.claude/settings.json.",
    }),
    json: Flags.boolean({ description: "Emit machine-readable JSON output", default: false }),
  };

  async run(): Promise<void> {
    const { flags } = await this.parse(HookInstall);
    const mode = resolveOutputMode({ json: flags.json });
    const scope: HookScope = flags.global ? "global" : "project";

    try {
      const { path: file, command } = installHook(scope);

      // Warn (don't fail) when no headless token is configured — the hook would
      // otherwise fail when it fires.
      const endpoint = resolveEndpoint({ env: process.env["FRUGL_ENDPOINT"] });
      const tokenConfigured = (await resolveHeadlessToken({ endpointUrl: endpoint.url })) !== null;

      if (mode === "json") {
        process.stdout.write(
          `${JSON.stringify({
            command: "hook install",
            ok: true,
            path: file,
            hookCommand: command,
            scope,
            tokenConfigured,
          })}\n`,
        );
        return;
      }

      process.stdout.write(
        `${color.ok(`${symbol.tick} Installed Claude Code hook`)}  ${color.dim(`(${scope}: ${file})`)}\n`,
      );
      process.stdout.write(`${color.dim("  Runs on session end: ")}${color.poppy(command)}\n`);
      if (!tokenConfigured) {
        process.stderr.write(
          `${color.warn(`${symbol.warn} No access token configured.`)} ${color.dim(
            "Set FRUGL_TOKEN or run 'frugl login --token <code>', or the hook will fail when it runs.",
          )}\n`,
        );
      }
    } catch (err) {
      if (isFruglError(err)) process.exit(printFruglError(err, mode));
      throw err;
    }
  }
}
