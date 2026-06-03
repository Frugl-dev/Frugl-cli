import { Command } from "@oclif/core";
import { resolveOutputMode } from "../../lib/output-mode.js";
import { COMMON_FLAGS, handleCommandError } from "../../lib/command-context.js";
import { authedClient } from "../../org/runtime.js";
import { color, symbol } from "../../lib/theme.js";

export default class OrgInvites extends Command {
  static override description = "How to accept an invite to an org.";

  static override flags = COMMON_FLAGS;

  async run(): Promise<void> {
    const { flags } = await this.parse(OrgInvites);
    const mode = resolveOutputMode({ json: flags.json });

    try {
      // Confirms the session is valid; there is no invite-listing endpoint yet,
      // so we explain the code-based join path rather than guess at one.
      const { session } = await authedClient(flags.endpoint);

      if (mode === "json") {
        process.stdout.write(
          `${JSON.stringify({
            command: "org invites",
            ok: true,
            email: session.email,
            invites: null,
            note: "invite listing is not available; accept by code with `frugl org join <code>`",
          })}\n`,
        );
        return;
      }

      process.stdout.write(`${color.bold(`${symbol.bullet} Invites are accepted by code.`)}\n`);
      process.stdout.write(
        `${color.dim(`  Ask a teammate for an invite code (sent to ${session.email}), then run:`)}\n`,
      );
      process.stdout.write(`    ${color.poppy("frugl org join <code>")}\n`);
    } catch (err) {
      handleCommandError(err, mode);
    }
  }
}
