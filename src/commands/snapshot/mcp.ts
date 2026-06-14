import { Command } from "@oclif/core";
import {
  buildCommandContext,
  COMMON_FLAGS,
  handleCommandError,
} from "../../lib/command-context.js";
import { requestHandoffUrl, resolveHandoffPreference } from "../../cloud/handoff.js";
import { runMcpSnapshot } from "../../snapshot/run.js";
import { printSnapshotResult } from "../../snapshot/output.js";

// A timestamped capture of the configured MCP-server inventory (name, transport,
// target, status) from `claude mcp list`. Server targets can embed secrets and
// are scrubbed locally before upload; server names are preserved as config
// identifiers. Fail-closed: a missing/failing `claude` binary or a zero-server
// inventory exits non-zero with NO upload.
export default class SnapshotMcp extends Command {
  static override description = `Capture and upload a timestamped MCP-server inventory snapshot from Claude Code. Each run accumulates a distinct snapshot; a failed run never blocks the next.

Exit codes:
  0   success
 10   not authenticated — run: frugl login
 30   anonymization failure
 40   network error`;

  static override examples = [
    "<%= config.bin %> <%= command.id %>",
    "<%= config.bin %> <%= command.id %> --format json",
  ];

  static override flags = COMMON_FLAGS;

  async run(): Promise<void> {
    const { flags } = await this.parse(SnapshotMcp);
    const { mode, client, session } = await buildCommandContext(flags, { auth: "require" });

    try {
      const result = await runMcpSnapshot({ client, session });
      const handoff = await requestHandoffUrl(
        client,
        result.dashboardUrl,
        resolveHandoffPreference(undefined, Boolean(process.stdout.isTTY), mode),
      );
      printSnapshotResult({ command: "snapshot mcp", result, handoff, mode });
    } catch (err) {
      handleCommandError(err, mode);
    }
  }
}
