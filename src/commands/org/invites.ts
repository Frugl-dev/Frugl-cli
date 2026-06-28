import { Command } from "@oclif/core";
import { resolveOutputMode } from "../../lib/output-mode.js";
import { COMMON_FLAGS } from "../../lib/command-context.js";
import { color, symbol } from "../../lib/theme.js";

export default class OrgInvites extends Command {
  static override description = "How to accept an invite to an org.";

  static override examples = [
    "<%= config.bin %> <%= command.id %>   # how to get and redeem an invite",
  ];

  static override flags = COMMON_FLAGS;

  async run(): Promise<void> {
    const { flags } = await this.parse(OrgInvites);
    const mode = resolveOutputMode({ format: flags.format });

    if (mode === "json") {
      process.stdout.write(
        `${JSON.stringify({
          command: "org invites",
          ok: true,
          invites: null,
          note: "invite listing is not available; accept by code with `frugl org join <code>`",
        })}\n`,
      );
      return;
    }

    process.stdout.write(`${color.bold(`${symbol.bullet} Invites are accepted by code.`)}\n`);
    process.stdout.write(color.dim("  Ask a teammate for an invite code, then run:\n"));
    process.stdout.write(`    ${color.frog("frugl org join <code>")}\n`);
  }
}
