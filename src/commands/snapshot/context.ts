import { Command } from "@oclif/core";
import {
  buildCommandContext,
  COMMON_FLAGS,
  handleCommandError,
} from "../../lib/command-context.js";
import { requestHandoffUrl, resolveHandoffPreference } from "../../cloud/handoff.js";
import { runContextSnapshot } from "../../snapshot/run.js";
import { printSnapshotResult } from "../../snapshot/output.js";

// v1 has no built-in scheduler. To capture snapshots on a cadence, drive
// `frugl snapshot context` from an external cron/CI job (see README).
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
    const { mode, client, session } = await buildCommandContext(flags, { auth: "require" });

    try {
      const result = await runContextSnapshot({ client, session });
      const handoff = await requestHandoffUrl(
        client,
        result.dashboardUrl,
        resolveHandoffPreference(undefined, Boolean(process.stdout.isTTY), mode),
      );
      printSnapshotResult({ command: "snapshot context", result, handoff, mode });
    } catch (err) {
      handleCommandError(err, mode);
    }
  }
}
