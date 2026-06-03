import { Args, Command, Flags } from "@oclif/core";
import { CloudHttpError } from "../../cloud/client.js";
import { isFruglError, printFruglError } from "../../lib/errors.js";
import { resolveOutputMode } from "../../lib/output-mode.js";
import { authedClient, fetchOrgContext } from "../../org/runtime.js";
import { renderNoOrg } from "../../org/render.js";
import { color, symbol } from "../../lib/theme.js";

export default class OrgUse extends Command {
  static override description = "Set the active org for subsequent uploads.";

  static override args = {
    slug: Args.string({ description: "Org slug to switch to", required: true }),
  };

  static override flags = {
    endpoint: Flags.string({ description: "Override the API endpoint" }),
    json: Flags.boolean({ description: "Emit machine-readable JSON output", default: false }),
  };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(OrgUse);
    const mode = resolveOutputMode({ json: flags.json });

    try {
      const { client, session } = await authedClient(flags.endpoint);
      const ctx = await fetchOrgContext(client);

      // The cloud models a single active org per account today — there is no
      // switch endpoint. We can only confirm the slug the account is already on.
      const onRequested = ctx.kind === "member" && ctx.slug === args.slug;

      if (mode === "json") {
        process.stdout.write(
          `${JSON.stringify({
            command: "org use",
            ok: onRequested,
            requested: args.slug,
            activeSlug: ctx.kind === "member" ? ctx.slug : null,
            ...(onRequested ? {} : { reason: "switch-unavailable" }),
          })}\n`,
        );
        process.exit(0);
      }

      if (ctx.kind === "none") {
        process.stdout.write(`${renderNoOrg(session.email)}\n`);
        process.exit(0);
      }

      if (onRequested) {
        process.stdout.write(
          `${color.ok(`${symbol.tick} Active org → ${ctx.slug}`)}  ${color.dim(`(role: ${ctx.role})`)}\n`,
        );
        process.exit(0);
      }

      process.stdout.write(
        `${color.warn(`${symbol.warn} You're in ${ctx.slug}, not ${args.slug}.`)}\n`,
      );
      process.stdout.write(
        color.dim(
          "  An account belongs to one org today; switching between orgs isn't available yet.\n",
        ),
      );
      process.stdout.write(
        `${color.dim("  To move to another org, join it with ")}${color.poppy("frugl org join <code>")}${color.dim(".")}\n`,
      );
      process.exit(0);
    } catch (err) {
      if (isFruglError(err) || err instanceof CloudHttpError) {
        process.exit(printFruglError(err, mode));
      }
      throw err;
    }
  }
}
