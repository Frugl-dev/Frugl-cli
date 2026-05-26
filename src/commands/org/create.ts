import { Command, Flags } from "@oclif/core";
import { input } from "@inquirer/prompts";
import { CloudHttpError } from "../../cloud/client.js";
import { isPoppiError, printPoppiError, UsageError } from "../../lib/errors.js";
import { resolveOutputMode } from "../../lib/output-mode.js";
import { authedClient } from "../../org/runtime.js";
import { setupOrg, type OrgSetupAction } from "../../org/setup.js";
import { deriveSlug } from "../../org/slug.js";
import { color, symbol } from "../../lib/theme.js";

export default class OrgCreate extends Command {
  static override description = "Create a new org. You become the owner.";

  static override flags = {
    name: Flags.string({ description: "Org name (skips the interactive prompt)" }),
    endpoint: Flags.string({ description: "Override the API endpoint" }),
    json: Flags.boolean({ description: "Emit machine-readable JSON output", default: false }),
  };

  async run(): Promise<void> {
    const { flags } = await this.parse(OrgCreate);
    const mode = resolveOutputMode({ json: flags.json });

    try {
      if (mode === "json" && !flags.name) {
        throw new UsageError("org create --json requires --name (cannot prompt in JSON mode).");
      }

      const { client } = await authedClient(flags.endpoint);

      let name = flags.name ?? (await this.promptName("Org name"));
      let action: OrgSetupAction = { action: "create", name, slug: deriveSlug(name) };

      // Retry on slug conflicts; in JSON mode a conflict is a hard failure.
      // eslint-disable-next-line no-constant-condition
      while (true) {
        // eslint-disable-next-line no-await-in-loop
        const result = await setupOrg(client, action);

        if (result.status === "created" || result.status === "already-setup") {
          if (mode === "json") {
            process.stdout.write(
              `${JSON.stringify({
                command: "org create",
                ok: true,
                slug: result.slug,
                name: result.orgName,
                outcome: result.status === "created" ? "created" : "existing",
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
              `${color.ok(`${symbol.tick} Org created.`)}  ${color.dim("You're the owner of ")}${color.bold(result.slug)}${color.dim(".")}\n`,
            );
          }
          return;
        }

        if (result.status === "slug-taken") {
          if (mode === "json") {
            throw new UsageError(
              `Slug is taken. Try a different name (suggestion: ${result.suggestion}).`,
            );
          }
          process.stderr.write(
            `${color.warn(`${symbol.warn} That slug is already taken.`)} ${color.dim(`Try: ${result.suggestion}`)}\n`,
          );
          // eslint-disable-next-line no-await-in-loop
          name = await this.promptName("Org name (try a different one)");
          action = { action: "create", name, slug: deriveSlug(name) };
          continue;
        }

        // setupOrg only returns join-related statuses for join intents.
        throw new UsageError(`Unexpected org-create result: ${result.status}`);
      }
    } catch (err) {
      if (isPoppiError(err) || err instanceof CloudHttpError) {
        process.exit(printPoppiError(err, mode));
      }
      throw err;
    }
  }

  private async promptName(message: string): Promise<string> {
    return input({
      message: `${message}:`,
      validate: (v) => (v.trim().length > 0 && v.length <= 80) || "Name must be 1–80 characters",
    });
  }
}
