import { Command, Flags } from "@oclif/core";
import { input } from "@inquirer/prompts";
import { CloudHttpError } from "../../cloud/client.js";
import { isFruglError, printFruglError, UsageError } from "../../lib/errors.js";
import { resolveOutputMode } from "../../lib/output-mode.js";
import { authedClient } from "../../org/runtime.js";
import type { OrgSetupAction } from "../../org/setup.js";
import { runOrgSetupFlow } from "../../org/flow.js";
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

      const name = flags.name ?? (await this.promptName("Org name"));
      const action: OrgSetupAction = { action: "create", name, slug: deriveSlug(name) };

      // The flow drives create + slug-conflict retries; we only supply the
      // reprompt (text) / hard-fail (JSON) behaviour for a taken slug. A
      // create intent can never yield a join outcome.
      const result = await runOrgSetupFlow(client, action, {
        onSlugTaken: async (suggestion) => {
          if (mode === "json") {
            throw new UsageError(
              `Slug is taken. Try a different name (suggestion: ${suggestion}).`,
            );
          }
          process.stderr.write(
            `${color.warn(`${symbol.warn} That slug is already taken.`)} ${color.dim(`Try: ${suggestion}`)}\n`,
          );
          return this.promptName("Org name (try a different one)");
        },
        onInvalidCode: () => {
          throw new UsageError("Unexpected org-create result: invalid-code");
        },
        onExpiredCode: () => {
          throw new UsageError("Unexpected org-create result: expired-code");
        },
      });

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
    } catch (err) {
      if (isFruglError(err) || err instanceof CloudHttpError) {
        process.exit(printFruglError(err, mode));
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
