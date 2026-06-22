import { Command } from "@oclif/core";
import {
  buildCommandContext,
  COMMON_FLAGS,
  handleCommandError,
} from "../../lib/command-context.js";
import { resolveOutputMode } from "../../lib/output-mode.js";
import { reportMcp, runMcpSnapshot } from "../../mcp-snapshot/run.js";

export default class SnapshotMcp extends Command {
  static override description = `Capture and upload a timestamped snapshot of your declared MCP servers from Claude Code (names, transport, target, health). Targets are anonymized on your machine before upload. Each run accumulates a distinct snapshot; a failed run never blocks the next.

Exit codes:
  0   success
 10   not authenticated — run: frugl login
 30   anonymization failure
 40   network error`;

  static override examples = [
    "<%= config.bin %> <%= command.id %>",
    "<%= config.bin %> <%= command.id %> --format json",
    "# Daily via crontab (no built-in scheduler):",
    "0 9 * * * <%= config.bin %> <%= command.id %> >> ~/.frugl/mcp.log 2>&1",
  ];

  static override flags = COMMON_FLAGS;

  async run(): Promise<void> {
    const { flags } = await this.parse(SnapshotMcp);
    const mode = resolveOutputMode({ format: flags.format });
    try {
      const ctx = await buildCommandContext(flags, { auth: "require" });
      const report = await runMcpSnapshot(ctx);
      reportMcp(report, ctx.mode);
    } catch (err) {
      handleCommandError(err, mode);
    }
  }
}
