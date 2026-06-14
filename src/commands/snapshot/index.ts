import { Command, Flags } from "@oclif/core";
import { buildCommandContext, COMMON_FLAGS } from "../../lib/command-context.js";
import { resolveOutputMode, type OutputMode } from "../../lib/output-mode.js";
import { printFruglError } from "../../lib/errors.js";
import { EXIT, type ExitCode } from "../../lib/exit-codes.js";
import { color, symbol } from "../../lib/theme.js";
import { requestHandoffUrl, resolveHandoffPreference } from "../../cloud/handoff.js";
import { SNAPSHOT_LABEL, SNAPSHOT_RUNNERS, type SnapshotKind } from "../../snapshot/run.js";
import { printSnapshotResult } from "../../snapshot/output.js";

// The order `--all` captures in. Context first (the bigger, more time-sensitive
// capture), then mcp.
const ALL_KINDS: SnapshotKind[] = ["context", "mcp"];

export default class Snapshot extends Command {
  static override description =
    "Capture a point-in-time snapshot and upload it. See: snapshot context, snapshot mcp, or --all.";

  static override examples = [
    "<%= config.bin %> <%= command.id %>            # list the snapshot kinds",
    "<%= config.bin %> <%= command.id %> --all      # capture + upload every kind",
    "<%= config.bin %> <%= command.id %> context    # only the /context breakdown",
    "<%= config.bin %> <%= command.id %> mcp        # only the MCP-server inventory",
  ];

  static override flags = {
    all: Flags.boolean({
      description: "Capture and upload every snapshot kind (context + mcp).",
    }),
    ...COMMON_FLAGS,
  };

  async run(): Promise<void> {
    const { flags } = await this.parse(Snapshot);
    const mode = resolveOutputMode({ format: flags.format });

    // Bare `frugl snapshot` is a non-destructive signpost — it uploads nothing,
    // so it needs no auth. Only `--all` captures.
    if (!flags.all) {
      printGuidance(mode);
      return;
    }

    const { client, session } = await buildCommandContext(flags, { auth: "require" });

    // Each kind is independently fallible: one failing (e.g. no MCP servers
    // configured) never blocks the other, and we report both outcomes. The
    // process exits non-zero if any kind failed, carrying the first failure's
    // exit code.
    let firstFailureCode: ExitCode | undefined;
    for (const kind of ALL_KINDS) {
      try {
        const result = await SNAPSHOT_RUNNERS[kind]({ client, session });
        const handoff = await requestHandoffUrl(
          client,
          result.dashboardUrl,
          resolveHandoffPreference(undefined, Boolean(process.stdout.isTTY), mode),
        );
        printSnapshotResult({ command: `snapshot ${kind}`, result, handoff, mode });
      } catch (err) {
        const code = reportKindFailure(kind, err, mode);
        if (firstFailureCode === undefined) firstFailureCode = code;
      }
    }

    if (firstFailureCode !== undefined) process.exit(firstFailureCode);
  }
}

// Report a single kind's failure without aborting the run. In json mode an error
// object goes to stdout (alongside the other kinds' result lines); otherwise the
// house-style `frugl: …` error goes to stderr. Returns the exit code to surface.
function reportKindFailure(kind: SnapshotKind, err: unknown, mode: OutputMode): ExitCode {
  if (mode === "json") {
    const message = err instanceof Error ? err.message : String(err);
    process.stdout.write(
      `${JSON.stringify({ command: `snapshot ${kind}`, ok: false, kind, error: message })}\n`,
    );
    const code = (err as { exitCode?: ExitCode }).exitCode;
    return code ?? EXIT.GENERIC_FAILURE;
  }
  process.stderr.write(`${color.warn(`${symbol.warn} ${SNAPSHOT_LABEL[kind]} failed.`)}\n`);
  return printFruglError(err, mode);
}

function printGuidance(mode: OutputMode): void {
  if (mode === "json") {
    process.stdout.write(
      `${JSON.stringify({
        command: "snapshot",
        kinds: ALL_KINDS,
        hint: "Run 'frugl snapshot <kind>' or 'frugl snapshot --all'.",
      })}\n`,
    );
    return;
  }
  const out = process.stdout;
  out.write(
    `\n  ${color.bold("frugl snapshot")}  ${color.dim("·  capture a point-in-time snapshot and upload it.")}\n\n`,
  );
  out.write(
    `  ${color.frog("context")}   ${color.dim("your Claude Code /context window breakdown")}\n`,
  );
  out.write(
    `  ${color.frog("mcp")}       ${color.dim("your configured MCP-server inventory")}\n\n`,
  );
  out.write(`  ${color.dim("Run one, or all at once:")}\n`);
  out.write(`    ${color.frog("frugl snapshot context")}\n`);
  out.write(`    ${color.frog("frugl snapshot mcp")}\n`);
  out.write(`    ${color.frog("frugl snapshot --all")}\n\n`);
}
