import { Args, Command, Flags } from "@oclif/core";
import { input } from "@inquirer/prompts";
import { CloudHttpError } from "../../cloud/client.js";
import { isFruglError, printFruglError, UsageError } from "../../lib/errors.js";
import { resolveOutputMode } from "../../lib/output-mode.js";
import { authedClient } from "../../org/runtime.js";
import type { OrgSetupAction } from "../../org/setup.js";
import { runOrgSetupFlow } from "../../org/flow.js";
import {
  makeOrgSetupPrompts,
  renderOrgSetupResult,
  type OrgSetupPresentation,
} from "../../org/presenter.js";
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

      // The flow drives join + bad-code retries; the presenter reprompts (text)
      // or hard-fails (JSON) on a bad code. A join intent can never yield a
      // slug-taken outcome, so `name` is omitted and the presenter guards it as
      // "unexpected result". The text warn keeps its colored "⚠ …" prefix while
      // JSON aborts with the plain problem string.
      const badCode = (problem: string) => ({
        warn: `${color.warn(`${symbol.warn} ${problem}`)}`,
        abort: problem,
      });
      const spec: OrgSetupPresentation = {
        command: "org join",
        reprompt: { code: () => this.promptCode() },
        messages: {
          slugTaken: () => ({
            warn: "Unexpected org-join result: slug-taken",
            abort: "Unexpected org-join result: slug-taken",
          }),
          invalidCode: badCode("Invite code not found. Check the code and try again."),
          expiredCode: badCode("That invite code has expired or been used up."),
        },
        render: {
          text: (r) =>
            r.status === "already-setup"
              ? `${color.ok(`${symbol.tick} You're already in ${r.orgName}`)}  ${color.dim(`(${r.slug}).`)}\n`
              : `${color.ok(`${symbol.tick} Joined ${r.slug}`)}  ${color.dim("as member.")}\n` +
                `${color.dim("  Next: ")}${color.poppy("frugl upload --dry-run")}\n`,
          json: (r) => ({
            command: "org join",
            ok: true,
            slug: r.slug,
            name: r.orgName,
            outcome: r.status === "joined" ? "joined" : "existing",
          }),
        },
      };

      const result = await runOrgSetupFlow(client, action, makeOrgSetupPrompts(spec, mode));
      renderOrgSetupResult(result, spec, mode);
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
