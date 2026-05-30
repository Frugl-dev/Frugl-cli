import { Command, Flags } from "@oclif/core";
import { confirm } from "@inquirer/prompts";
import { CloudClient, CloudHttpError } from "../cloud/client.js";
import { resolveEndpoint } from "../cloud/endpoints.js";
import { loadAuthSession } from "../auth/session.js";
import {
  recommendationApplyResponseSchema,
  recommendationDismissResponseSchema,
  recommendationsListResponseSchema,
  type RecommendationItem,
} from "../cloud/schemas.js";
import { getCliVersion } from "../lib/cli-version.js";
import { EXIT } from "../lib/exit-codes.js";
import { isPoppiError, printPoppiError } from "../lib/errors.js";
import { resolveOutputMode, type OutputMode } from "../lib/output-mode.js";
import { color, symbol } from "../lib/theme.js";

const STATUSES = ["open", "applied", "dismissed", "resolved", "all"] as const;

function formatSavings(usd: number): string {
  if (usd < 0.01) return "<$0.01";
  return `$${usd.toFixed(2)}`;
}

export default class Recommendations extends Command {
  static override description =
    "List and rank cost-saving recommendations, and get a prompt to fix them.";

  static override aliases = ["recs"];

  static override flags = {
    endpoint: Flags.string({ description: "Override the API endpoint" }),
    json: Flags.boolean({ description: "Emit machine-readable JSON output", default: false }),
    status: Flags.string({
      description: "Filter by status",
      options: [...STATUSES],
      default: "open",
    }),
    fix: Flags.string({ description: "Print the fix prompt for a recommendation id" }),
    apply: Flags.string({ description: "Mark a recommendation id applied" }),
    dismiss: Flags.string({ description: "Dismiss a recommendation id (snoozes 30 days)" }),
    yes: Flags.boolean({ description: "Skip confirmation prompts", default: false }),
  };

  async run(): Promise<void> {
    const { flags } = await this.parse(Recommendations);
    const mode = resolveOutputMode({ json: flags.json });
    const endpoint = resolveEndpoint({ flag: flags.endpoint, env: process.env["POPPI_ENDPOINT"] });

    try {
      const session = await loadAuthSession(endpoint.url);
      if (!session) {
        this.notLoggedIn(mode);
        process.exit(EXIT.AUTH_FAILURE);
      }

      const client = new CloudClient({
        endpointUrl: endpoint.url,
        cliVersion: getCliVersion(),
        token: session.token,
        endpointExplicit: endpoint.resolvedFrom !== "default",
      });

      if (flags.fix) return await this.printFix(client, flags.fix, mode);
      if (flags.apply) return await this.apply(client, flags.apply, mode, flags.yes);
      if (flags.dismiss) return await this.dismiss(client, flags.dismiss, mode, flags.yes);
      return await this.list(client, flags.status, mode);
    } catch (err) {
      if (isPoppiError(err) || err instanceof CloudHttpError) {
        process.exit(printPoppiError(err, mode));
      }
      throw err;
    }
  }

  private notLoggedIn(mode: OutputMode): void {
    if (mode === "json") {
      process.stdout.write(
        `${JSON.stringify({ command: "recommendations", ok: false, reason: "not-logged-in" })}\n`,
      );
    } else {
      process.stderr.write(`${color.err(`${symbol.cross} Not logged in.`)} `);
      process.stderr.write(
        `${color.dim("Run ")}${color.poppy("poppi login")}${color.dim(" first.")}\n`,
      );
    }
  }

  private async fetchAll(client: CloudClient, status: string): Promise<RecommendationItem[]> {
    const res = await client.call({
      method: "GET",
      path: `/api/recommendations?status=${encodeURIComponent(status)}`,
      schema: recommendationsListResponseSchema,
    });
    return res.recommendations;
  }

  private async list(client: CloudClient, status: string, mode: OutputMode): Promise<void> {
    const recs = await this.fetchAll(client, status);

    if (mode === "json") {
      process.stdout.write(
        `${JSON.stringify({ command: "recommendations", ok: true, recommendations: recs })}\n`,
      );
      return;
    }

    if (recs.length === 0) {
      process.stdout.write(`${color.dim("No recommendations right now.")}\n`);
      return;
    }

    process.stdout.write(
      `${color.bold("Cost-saving recommendations")} ${color.dim("(ranked)")}\n\n`,
    );
    recs.forEach((r, i) => {
      const savings = color.poppy(`~${formatSavings(r.estimated_savings_usd)}/mo`);
      const flag = r.status === "applied" ? color.ok(" [applied]") : "";
      process.stdout.write(`${color.dim(`${i + 1}.`)} ${savings}  ${color.bold(r.title)}${flag}\n`);
      process.stdout.write(`   ${color.dim(r.description)}\n`);
      process.stdout.write(`   ${color.dim(`id=${r.id}`)}\n`);
    });
    process.stdout.write(
      `\n${color.dim("Get a fix prompt: ")}${color.poppy("poppi recommendations --fix <id>")}\n`,
    );
  }

  private async printFix(client: CloudClient, id: string, mode: OutputMode): Promise<void> {
    const rec = (await this.fetchAll(client, "all")).find((r) => r.id === id);
    if (!rec) {
      if (mode === "json") {
        process.stdout.write(
          `${JSON.stringify({ command: "recommendations", ok: false, reason: "not-found" })}\n`,
        );
      } else {
        process.stderr.write(`${color.err(`${symbol.cross} No recommendation with id ${id}.`)}\n`);
      }
      process.exit(EXIT.GENERIC_FAILURE);
    }

    if (mode === "json") {
      process.stdout.write(
        `${JSON.stringify({ command: "recommendations", ok: true, fix_prompt: rec.fix_prompt })}\n`,
      );
      return;
    }
    // Raw prompt only, so it can be piped straight into a coding agent.
    process.stdout.write(`${rec.fix_prompt}\n`);
  }

  private async apply(
    client: CloudClient,
    id: string,
    mode: OutputMode,
    yes: boolean,
  ): Promise<void> {
    if (!yes && mode !== "json") {
      const ok = await confirm({ message: `Mark recommendation ${id} as applied?`, default: true });
      if (!ok) return;
    }
    const res = await client.call({
      method: "POST",
      path: `/api/recommendations/${encodeURIComponent(id)}/apply`,
      schema: recommendationApplyResponseSchema,
    });
    if (mode === "json") {
      process.stdout.write(`${JSON.stringify({ command: "recommendations", ok: true, ...res })}\n`);
      return;
    }
    process.stdout.write(
      `${symbol.tick} ${color.ok("Marked applied")} ${color.dim(`— measuring impact (id=${res.id})`)}\n`,
    );
  }

  private async dismiss(
    client: CloudClient,
    id: string,
    mode: OutputMode,
    yes: boolean,
  ): Promise<void> {
    if (!yes && mode !== "json") {
      const ok = await confirm({
        message: `Dismiss recommendation ${id} for 30 days?`,
        default: true,
      });
      if (!ok) return;
    }
    const res = await client.call({
      method: "POST",
      path: `/api/recommendations/${encodeURIComponent(id)}/dismiss`,
      schema: recommendationDismissResponseSchema,
    });
    if (mode === "json") {
      process.stdout.write(`${JSON.stringify({ command: "recommendations", ok: true, ...res })}\n`);
      return;
    }
    process.stdout.write(`${symbol.tick} ${color.dim(`Dismissed for 30 days (id=${res.id})`)}\n`);
  }
}
