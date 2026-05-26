import { Args, Command, Flags } from "@oclif/core";
import { input } from "@inquirer/prompts";
import { CloudHttpError } from "../../cloud/client.js";
import { isPoppiError, printPoppiError, UsageError } from "../../lib/errors.js";
import { resolveOutputMode } from "../../lib/output-mode.js";
import { authedClient } from "../../org/runtime.js";
import { setupOrg, type OrgSetupAction } from "../../org/setup.js";
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

      let code = args.code ?? (await this.promptCode());
      let action: OrgSetupAction = { action: "join", code };

      // eslint-disable-next-line no-constant-condition
      while (true) {
        // eslint-disable-next-line no-await-in-loop
        const result = await setupOrg(client, action);

        if (result.status === "joined" || result.status === "already-setup") {
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
            process.stdout.write(
              `${color.dim("  Next: ")}${color.poppy("poppi upload --dry-run")}\n`,
            );
          }
          return;
        }

        const problem =
          result.status === "expired-code"
            ? "That invite code has expired or been used up."
            : "Invite code not found. Check the code and try again.";

        if (mode === "json") throw new UsageError(problem);
        process.stderr.write(`${color.warn(`${symbol.warn} ${problem}`)}\n`);
        // eslint-disable-next-line no-await-in-loop
        code = await this.promptCode();
        action = { action: "join", code };
      }
    } catch (err) {
      if (isPoppiError(err) || err instanceof CloudHttpError) {
        process.exit(printPoppiError(err, mode));
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
