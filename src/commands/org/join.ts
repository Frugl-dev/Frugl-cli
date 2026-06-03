import { Args, Command, Flags } from "@oclif/core";
import { input } from "@inquirer/prompts";
import { CloudHttpError } from "../../cloud/client.js";
import { isFruglError, printFruglError, UsageError } from "../../lib/errors.js";
import { resolveOutputMode } from "../../lib/output-mode.js";
import { authedClient } from "../../org/runtime.js";
import type { OrgSetupAction } from "../../org/setup.js";
import { runOrgSetupFlow } from "../../org/flow.js";
import { color, symbol } from "../../lib/theme.js";

export default class OrgJoin extends Command {
  static override description = "Join an existing org with an invite code from a teammate.";

  static override args = {
    code: Args.string({ description: "Invite code (e.g. pop_inv_…)", required: false }),
  };

  static override flags = {
    endpoint: Flags.string({ description: "Override the API endpoint" }),
    json: Flags.boolean({ description: "Emit machine-readable JSON output", default: false }),
  };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(OrgJoin);
    const mode = resolveOutputMode({ json: flags.json });

    try {
      if (mode === "json" && !args.code) {
        throw new UsageError("org join --json requires the invite code as an argument.");
      }

      const { client } = await authedClient(flags.endpoint);

      const code = args.code ?? (await this.promptCode());
      const action: OrgSetupAction = { action: "join", code };

      // The flow drives join + bad-code retries; a join intent can never yield
      // a slug-taken outcome.
      const repromptOn = (problem: string) => async () => {
        if (mode === "json") throw new UsageError(problem);
        process.stderr.write(`${color.warn(`${symbol.warn} ${problem}`)}\n`);
        return this.promptCode();
      };
      const result = await runOrgSetupFlow(client, action, {
        onSlugTaken: () => {
          throw new UsageError("Unexpected org-join result: slug-taken");
        },
        onInvalidCode: repromptOn("Invite code not found. Check the code and try again."),
        onExpiredCode: repromptOn("That invite code has expired or been used up."),
      });

      if (mode === "json") {
        process.stdout.write(
          `${JSON.stringify({
            command: "org join",
            ok: true,
            slug: result.slug,
            name: result.orgName,
            outcome: result.status === "joined" ? "joined" : "existing",
          })}\n`,
        );
        return;
      }
      if (result.status === "already-setup") {
        process.stdout.write(
          `${color.ok(`${symbol.tick} You're already in ${result.orgName}`)}  ${color.dim(`(${result.slug}).`)}\n`,
        );
      } else {
        process.stdout.write(
          `${color.ok(`${symbol.tick} Joined ${result.slug}`)}  ${color.dim("as member.")}\n`,
        );
        process.stdout.write(`${color.dim("  Next: ")}${color.poppy("frugl upload --dry-run")}\n`);
      }
      return;
    } catch (err) {
      if (isFruglError(err) || err instanceof CloudHttpError) {
        process.exit(printFruglError(err, mode));
      }
      throw err;
    }
  }

  private async promptCode(): Promise<string> {
    const code = await input({
      message: "Invite code:",
      validate: (v) => v.trim().length > 0 || "Enter an invite code",
    });
    return code.trim();
  }
}
