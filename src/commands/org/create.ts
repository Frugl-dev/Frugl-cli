import { Command, Flags } from "@oclif/core";
import { input } from "@inquirer/prompts";
import { UsageError } from "../../lib/errors.js";
import { resolveOutputMode } from "../../lib/output-mode.js";
import { COMMON_FLAGS, handleCommandError } from "../../lib/command-context.js";
import { authedClient } from "../../org/runtime.js";
import type { OrgSetupAction } from "../../org/setup.js";
import { runOrgSetupFlow } from "../../org/flow.js";
import {
  makeOrgSetupPrompts,
  renderOrgSetupResult,
  type OrgSetupPresentation,
} from "../../org/presenter.js";
import { deriveSlug } from "../../org/slug.js";
import { color, symbol } from "../../lib/theme.js";

export default class OrgCreate extends Command {
  static override description = "Create a new org. You become the owner.";

  static override flags = {
    name: Flags.string({ description: "Org name (skips the interactive prompt)" }),
    ...COMMON_FLAGS,
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

      // The flow drives create + slug-conflict retries; the presenter supplies
      // the reprompt (text) / hard-fail (JSON) behaviour for a taken slug. A
      // create intent can never yield a join outcome, so the code branches are
      // omitted — the presenter guards them as "unexpected result".
      const spec: OrgSetupPresentation = {
        command: "org create",
        reprompt: { name: () => this.promptName("Org name (try a different one)") },
        messages: {
          slugTaken: (suggestion) => ({
            warn: `${color.warn(`${symbol.warn} That slug is already taken.`)} ${color.dim(`Try: ${suggestion}`)}`,
            abort: `Slug is taken. Try a different name (suggestion: ${suggestion}).`,
          }),
          invalidCode: {
            warn: "Unexpected org-create result: invalid-code",
            abort: "Unexpected org-create result: invalid-code",
          },
          expiredCode: {
            warn: "Unexpected org-create result: expired-code",
            abort: "Unexpected org-create result: expired-code",
          },
        },
        render: {
          text: (r) =>
            r.status === "already-setup"
              ? `${color.ok(`${symbol.tick} You're already in ${r.orgName}`)}  ${color.dim(`(${r.slug}).`)}\n`
              : `${color.ok(`${symbol.tick} Org created.`)}  ${color.dim("You're the owner of ")}${color.bold(r.slug)}${color.dim(".")}\n`,
          json: (r) => ({
            command: "org create",
            ok: true,
            slug: r.slug,
            name: r.orgName,
            outcome: r.status === "created" ? "created" : "existing",
          }),
        },
      };

      const result = await runOrgSetupFlow(client, action, makeOrgSetupPrompts(spec, mode));
      renderOrgSetupResult(result, spec, mode);
      return;
    } catch (err) {
      handleCommandError(err, mode);
    }
  }

  private async promptName(message: string): Promise<string> {
    return input({
      message: `${message}:`,
      validate: (v) => (v.trim().length > 0 && v.length <= 80) || "Name must be 1–80 characters",
    });
  }
}
