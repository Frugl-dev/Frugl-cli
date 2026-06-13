import { Command, Flags } from "@oclif/core";
import { confirm } from "@inquirer/prompts";
import { CloudClient } from "../cloud/client.js";
import {
  recommendationApplyResponseSchema,
  recommendationDismissResponseSchema,
  recommendationsListResponseSchema,
  type RecommendationItem,
} from "../cloud/schemas.js";
import { EXIT } from "../lib/exit-codes.js";
import { buildCommandContext, COMMON_FLAGS, handleCommandError } from "../lib/command-context.js";
import { type OutputMode } from "../lib/output-mode.js";
import { bar, color, symbol, SIGIL } from "../lib/theme.js";

const STATUSES = ["open", "applied", "dismissed", "resolved", "all"] as const;

function formatSavings(usd: number): string {
  if (usd < 0.01) return "<$0.01";
  return `$${usd.toFixed(2)}`;
}

// "$312.40" → "~$312.40/mo", padded to a fixed width so the savings column
// lines up across rows regardless of magnitude.
function savingsCol(usd: number): string {
  const s = `~${formatSavings(usd)}/mo`;
  return s + " ".repeat(Math.max(0, 11 - s.length));
}

// Snake/kebab category keys ("root_context_bloat") → a readable tag
// ("root context bloat"). Generic so it survives new server categories.
function humanizeCategory(category: string): string {
  return category.replace(/[_-]+/g, " ").trim().toLowerCase();
}

// The status word used in the list header / footer copy.
function statusWord(status: string): string {
  return status === "all" ? "" : status;
}

// Pad a fixed-width impact label so the values line up.
function impactLabel(label: string): string {
  return label + " ".repeat(Math.max(0, 11 - label.length));
}

export default class Recommendations extends Command {
  static override description =
    "List and rank cost-saving recommendations, and get a prompt to fix them.";

  static override aliases = ["recs"];

  static override flags = {
    ...COMMON_FLAGS,
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
    const { mode, client, session } = await buildCommandContext(flags, { auth: "optional" });

    try {
      if (!session) {
        this.notLoggedIn(mode);
        process.exit(EXIT.AUTH_FAILURE);
      }

      if (flags.fix) return await this.printFix(client, flags.fix, mode);
      if (flags.apply) return await this.apply(client, flags.apply, mode, flags.yes);
      if (flags.dismiss) return await this.dismiss(client, flags.dismiss, mode, flags.yes);
      return await this.list(client, flags.status, mode);
    } catch (err) {
      handleCommandError(err, mode);
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
        `${color.dim("Run ")}${color.frog("frugl login")}${color.dim(" first.")}\n`,
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
      this.printEmpty();
      return;
    }

    // Applied recs carry a measured `impact` object — render the loop-closing
    // before/after view instead of the plain ranked list.
    if (status === "applied") {
      this.printImpact(recs);
      return;
    }

    // The reveal — "here's what to fix next." Warm header for the default
    // "what should I fix this week?" run; a neutral, precise header when the
    // user is filtering by an explicit status.
    const isOpen = status === "open";
    const word = statusWord(status);
    const n = recs.length;
    if (isOpen) {
      const things = n === 1 ? "thing" : "things";
      process.stdout.write(
        `  ${color.frog(SIGIL)}  ${color.bold(`${n} ${things} worth fixing this week.`)}` +
          `   ${color.dim("ranked by what they cost you.")}\n\n`,
      );
    } else {
      const count = `${n}${word ? ` ${word}` : ""}`;
      process.stdout.write(
        `${color.bold("Cost-saving recommendations")} ${color.dim(`(ranked · ${count})`)}\n\n`,
      );
    }

    recs.forEach((r, i) => {
      const savings = color.frogBold(savingsCol(r.estimated_savings_usd));
      const flag = r.status === "applied" ? color.ok(" [applied]") : "";
      process.stdout.write(
        `  ${color.frogBold(`#${i + 1}`)}  ${savings} ${color.bold(r.title)}${flag}\n`,
      );
      // Category tag in amber — the waste taxonomy, the meter color.
      process.stdout.write(
        `      ${color.warn(humanizeCategory(r.category))}   ${color.dim(`· ${r.description}`)}\n`,
      );
      // The top item gets the pipe-to-agent CTA; the rest carry their id.
      if (i === 0) {
        process.stdout.write(
          `      ${color.dim("→ ")}${color.frog(`frugl recommendations --fix ${r.id} | claude`)}` +
            `   ${color.dim("hand it straight to an agent")}\n\n`,
        );
      } else {
        process.stdout.write(`      ${color.dim(`id=${r.id}`)}\n\n`);
      }
    });

    const total = recs.reduce((sum, r) => sum + r.estimated_savings_usd, 0);
    process.stdout.write(`  ${color.dim("─".repeat(42))}\n`);
    if (isOpen) {
      process.stdout.write(
        `  ${color.frogBold(`~${formatSavings(total)}/mo`)}` +
          `${color.dim(` on the table across the top ${n}. Start with `)}${color.bold("#1")}` +
          `${color.dim(" — it's the biggest.")}\n`,
      );
    } else {
      const plural = n === 1 ? "recommendation" : "recommendations";
      process.stdout.write(
        `  ${color.frogBold(`~${formatSavings(total)}/mo`)}` +
          `${color.dim(` across ${n} ${word ? `${word} ` : ""}${plural}.`)}\n`,
      );
    }
  }

  // Warm empty state — no recommendations isn't an error. Why it's empty + the
  // two ways forward, and a reminder that nothing to fix is a good place to be.
  private printEmpty(): void {
    const dot = color.mute("·");
    process.stdout.write(
      `  ${color.frog(SIGIL)}   ${color.bold("No recommendations yet — Frugl's still chewing.")}\n\n`,
    );
    process.stdout.write(
      `  ${color.dim("Either you're caught up, or the analysis hasn't seen enough of a recent")}\n`,
    );
    process.stdout.write(
      `  ${color.dim("retro yet — it runs server-side and lands when it's sure.")}\n\n`,
    );
    process.stdout.write(
      `  ${dot} New here? ${color.underline("frugl upload")}` +
        ` — recommendations land after your first retro.\n`,
    );
    process.stdout.write(
      `  ${dot} Snoozed some? ${color.underline("frugl recommendations --status dismissed")} to see them.\n\n`,
    );
    process.stdout.write(`  ${color.dim("Nothing to fix is a good place to be. Stay green.")}\n`);
  }

  // The impact view (`--status applied`): baseline vs. now, realized savings,
  // and a measuring/available indicator — closing the recommend→fix→measure loop.
  private printImpact(recs: RecommendationItem[]): void {
    process.stdout.write(
      `${color.bold("Applied recommendations")} ` +
        `${color.dim("— impact (measured against your baseline)")}\n\n`,
    );

    let realizedTotal = 0;
    let measuring = 0;
    let available = 0;

    recs.forEach((r) => {
      process.stdout.write(`${symbol.tick} ${color.bold(r.title)}   ${color.dim(r.id)}\n`);
      const im = r.impact;
      if (!im) {
        process.stdout.write(
          `    ${color.mute(impactLabel("Measuring"))}${color.dim("not started yet")}\n\n`,
        );
        return;
      }

      process.stdout.write(
        `    ${color.mute(impactLabel("Baseline"))}${formatSavings(im.baseline_cost_usd)}/mo` +
          `   ${color.dim(`${im.baseline_window_days} days before applying`)}\n`,
      );

      if (im.measurement_status === "available") {
        available += 1;
        if (im.actual_cost_usd != null) {
          process.stdout.write(
            `    ${color.mute(impactLabel("Now"))}${formatSavings(im.actual_cost_usd)}/mo` +
              `   ${color.dim("trailing window, annualized")}\n`,
          );
        }
        const realized = im.realized_savings_usd ?? 0;
        realizedTotal += realized;
        const ratio = im.baseline_cost_usd > 0 ? realized / im.baseline_cost_usd : 0;
        process.stdout.write(
          `    ${color.mute(impactLabel("Realized"))}` +
            `${color.ok(`~${formatSavings(realized)}/mo saved`)}   ${bar(ratio * 20, 20, "frog")}` +
            `  ${symbol.activeDot} ${color.dim("available")}\n\n`,
        );
      } else {
        measuring += 1;
        process.stdout.write(
          `    ${color.mute(impactLabel("Measuring"))}${color.warn("in progress")}` +
            `   ${color.warn("●")} ${color.dim("measuring")}\n\n`,
        );
      }
    });

    const parts: string[] = [];
    if (measuring > 0) parts.push(`${measuring} measuring`);
    if (available > 0) parts.push(`${available} available`);
    const suffix = parts.length > 0 ? `  ${color.dim(`· ${parts.join(" · ")}`)}` : "";
    process.stdout.write(
      `  ${color.mute("Total realized so far  ")}` +
        `${color.frogBold(`~${formatSavings(realizedTotal)}/mo`)}${suffix}\n`,
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
    if (!yes && mode === "default") {
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
    if (!yes && mode === "default") {
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
