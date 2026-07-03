import { Command } from "@oclif/core";
import { buildCommandContext, COMMON_FLAGS } from "../../lib/command-context.js";
import { readProjectConfig } from "../../config/project-config.js";
import { runAllSnapshots } from "../../snapshot/all.js";

export default class Snapshot extends Command {
  static override description = `Capture and upload both snapshots — your Claude Code context window and your declared MCP servers — in one run. See also: snapshot context, snapshot mcp.

Each snapshot runs independently: a failure in one is reported but never blocks
the other. The process exits non-zero if either failed.

Exit codes:
  0   both succeeded
 10   not authenticated — run: frugl login
 30   anonymization failure
 40   network error`;

  static override examples = [
    "<%= config.bin %> <%= command.id %>",
    "<%= config.bin %> <%= command.id %> --format json",
    "<%= config.bin %> <%= command.id %> context",
    "<%= config.bin %> <%= command.id %> mcp",
  ];

  static override flags = COMMON_FLAGS;

  async run(): Promise<void> {
    const { flags } = await this.parse(Snapshot);
    if (readProjectConfig()?.snapshot?.enabled === false) {
      process.stderr.write("Snapshot disabled in .frugl.json — nothing captured.\n");
      return;
    }
    const ctx = await buildCommandContext(flags, { auth: "require" });
    const exitCode = await runAllSnapshots(ctx);
    // this.exit (not process.exit): standalone runs still exit with this code,
    // but a programmatic caller (upload's auto mode, init) gets a catchable
    // ExitError instead of the whole process being torn down under it.
    if (exitCode !== 0) this.exit(exitCode);
  }
}
