import { Command } from "@oclif/core";
import { anonymize } from "../anonymize/index.js";
import { buildCommandContext, COMMON_FLAGS, handleCommandError } from "../lib/command-context.js";
import { color, symbol } from "../lib/theme.js";
import { captureContext } from "../context/capture.js";
import { uploadContextSnapshot } from "../context/upload.js";
import { captureDeclaredMcpServers } from "../capture/claude/mcp-inventory.js";
import { HttpCloudAdapter } from "../upload/cloud-http-adapter.js";
import { requestHandoffUrl, resolveHandoffPreference } from "../cloud/handoff.js";

// v1 has no built-in scheduler. To capture snapshots on a cadence, drive
// `frugl context` from an external cron/CI job (see README). The tool is the
// configured AI tool whose /context breakdown is captured; today only Claude
// Code is wired.
const TOOL = "claude-code";

export default class Context extends Command {
  static override description =
    "Capture the configured AI tool's context breakdown (Claude Code's /context), anonymize it, and upload a timestamped snapshot. No built-in scheduler in v1: run on a cadence via external cron/CI (e.g. `0 9 * * * frugl context >> ~/.frugl/context.log 2>&1`). Each run accumulates a distinct snapshot; a failed run never blocks the next.";

  static override examples = [
    "<%= config.bin %> <%= command.id %>",
    "<%= config.bin %> <%= command.id %> --json",
    "# Daily via crontab (no built-in scheduler):",
    "0 9 * * * <%= config.bin %> <%= command.id %> >> ~/.frugl/context.log 2>&1",
  ];

  static override flags = COMMON_FLAGS;

  async run(): Promise<void> {
    const { flags } = await this.parse(Context);
    const { mode, client, session } = await buildCommandContext(flags, { auth: "require" });

    try {
      // 1) Capture (fail-closed): missing binary / non-zero exit / empty stdout
      // each throw before any upload. capturedAt is stamped at capture time.
      const capture = captureContext(TOOL);

      // 2) Anonymize the captured TEXT client-side (fail-closed). The home prefix
      // is normalized and embedded secrets/emails are redacted; skill/MCP/agent
      // names and memory-file paths are preserved as config identifiers.
      const homeDir = process.env["FRUGL_HOME_DIR"];
      const result = anonymize(capture.text, {
        uploadId: capture.capturedAt,
        ownerEmail: session.email,
        ...(homeDir !== undefined ? { homeDir } : {}),
      });

      // 3) Upload via the manifest -> presign -> PUT -> complete handshake.
      // The declared MCP inventory (names-only, fail-open) rides the manifest:
      // a failed `claude mcp list` simply omits it, never blocking the snapshot.
      const cloud = new HttpCloudAdapter(client);
      const mcpServers = captureDeclaredMcpServers();
      const upload = await uploadContextSnapshot({
        cloud,
        cliVersion: client.cliVersion,
        sourceKind: TOOL,
        policyVersion: result.policyVersion,
        capturedAt: capture.capturedAt,
        anonymization: result,
        ...(mcpServers ? { mcpServers } : {}),
      });

      const handoff = await requestHandoffUrl(
        client,
        upload.dashboardUrl,
        resolveHandoffPreference(undefined, Boolean(process.stdout.isTTY), mode),
      );

      if (mode === "json") {
        process.stdout.write(
          `${JSON.stringify({
            command: "context",
            ok: true,
            tool: TOOL,
            capturedAt: capture.capturedAt,
            manifestId: upload.manifestId,
            sessionId: upload.sessionId,
            redactionPolicyVersion: result.policyVersion,
            byteSize: result.byteSize,
            dashboardUrl: handoff.dashboardUrl,
          })}\n`,
        );
        return;
      }

      process.stdout.write(
        `${color.ok(`${symbol.tick} Context snapshot captured`)} ${color.dim(`at ${capture.capturedAt}`)}\n`,
      );
      process.stdout.write(
        `${color.dim("  View it on your dashboard: ")}${color.poppy(handoff.dashboardUrl)}\n`,
      );
      if (handoff.active) {
        process.stdout.write(
          color.dim(
            "             link signs you in — expires in ~60s; after that, log in normally\n",
          ),
        );
      } else if (handoff.reason !== "disabled-flag" && handoff.reason !== "disabled-default") {
        process.stdout.write(
          color.dim("             sign-in link unavailable — log in on the web\n"),
        );
      }
    } catch (err) {
      handleCommandError(err, mode);
    }
  }
}
