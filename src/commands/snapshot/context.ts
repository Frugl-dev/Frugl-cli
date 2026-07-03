import { Command, Flags } from "@oclif/core";
import {
  buildCommandContext,
  COMMON_FLAGS,
  handleCommandError,
} from "../../lib/command-context.js";
import { resolveOutputMode } from "../../lib/output-mode.js";
import type { ContextTool } from "../../context/capture.js";
import { reportContext, runContextSnapshot } from "../../context/run.js";

export default class SnapshotContext extends Command {
  static override description = `Capture and upload a timestamped context snapshot. Claude Code captures the provider-reported /context breakdown; codex/gemini/cursor capture an artifact-loadout snapshot (instruction/rules files + declared MCP servers, sizes only — estimated tokens). Each run accumulates a distinct snapshot; a failed run never blocks the next.

Exit codes:
  0   success
 10   not authenticated — run: frugl login
 30   anonymization failure
 40   network error`;

  static override examples = [
    "<%= config.bin %> <%= command.id %>",
    "<%= config.bin %> <%= command.id %> --tool gemini",
    "<%= config.bin %> <%= command.id %> --format json",
    "# Daily via crontab (no built-in scheduler):",
    "0 9 * * * <%= config.bin %> <%= command.id %> >> ~/.frugl/context.log 2>&1",
  ];

  static override flags = {
    ...COMMON_FLAGS,
    tool: Flags.string({
      description:
        "AI tool to snapshot (claude-code = /context breakdown; codex/gemini/cursor = artifact loadout)",
      options: ["claude-code", "codex", "gemini", "cursor"],
      default: "claude-code",
    }),
  };

  async run(): Promise<void> {
    const { flags } = await this.parse(SnapshotContext);
    const mode = resolveOutputMode({ format: flags.format });
    try {
      const ctx = await buildCommandContext(flags, { auth: "require" });
      const tool = flags.tool as ContextTool;
      const report = await runContextSnapshot(ctx, tool);
      reportContext(report, ctx.mode, tool);
    } catch (err) {
      handleCommandError(err, mode);
    }
  }
}
