import { Command } from "@oclif/core";
import {
  buildCommandContext,
  COMMON_FLAGS,
  handleCommandError,
} from "../../lib/command-context.js";
import { reportContext, runContextSnapshot } from "../../context/run.js";

export default class SnapshotContext extends Command {
  static override description = `Capture and upload a timestamped context snapshot from Claude Code. Each run accumulates a distinct snapshot; a failed run never blocks the next.

Exit codes:
  0   success
 10   not authenticated — run: frugl login
 30   anonymization failure
 40   network error`;

  static override examples = [
    "<%= config.bin %> <%= command.id %>",
    "<%= config.bin %> <%= command.id %> --format json",
    "# Daily via crontab (no built-in scheduler):",
    "0 9 * * * <%= config.bin %> <%= command.id %> >> ~/.frugl/context.log 2>&1",
  ];

  static override flags = COMMON_FLAGS;

  async run(): Promise<void> {
    const { flags } = await this.parse(SnapshotContext);
    const ctx = await buildCommandContext(flags, { auth: "require" });
    try {
      const report = await runContextSnapshot(ctx);
      reportContext(report, ctx.mode);
    } catch (err) {
      handleCommandError(err, ctx.mode);
    }
  }
}
