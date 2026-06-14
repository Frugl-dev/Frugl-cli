import { color, symbol } from "../lib/theme.js";
import type { OutputMode } from "../lib/output-mode.js";
import type { HandoffResult } from "../cloud/handoff.js";
import { SNAPSHOT_LABEL, type SnapshotResult } from "./run.js";

// Render a single snapshot upload receipt — the JSON line for machine modes, or
// the human "captured at …" line plus the (optionally sign-in-decorated)
// dashboard link. Mirrors the upload command's handoff messaging so the two
// surfaces read the same.
export function printSnapshotResult(args: {
  command: string;
  result: SnapshotResult;
  handoff: HandoffResult;
  mode: OutputMode;
}): void {
  const { command, result, handoff, mode } = args;

  if (mode === "json") {
    process.stdout.write(
      `${JSON.stringify({
        command,
        ok: true,
        kind: result.kind,
        tool: result.tool,
        capturedAt: result.capturedAt,
        manifestId: result.manifestId,
        sessionId: result.sessionId,
        redactionPolicyVersion: result.redactionPolicyVersion,
        byteSize: result.byteSize,
        dashboardUrl: handoff.dashboardUrl,
      })}\n`,
    );
    return;
  }

  process.stdout.write(
    `${color.ok(`${symbol.tick} ${SNAPSHOT_LABEL[result.kind]} captured`)} ${color.dim(`at ${result.capturedAt}`)}\n`,
  );
  process.stdout.write(
    `${color.dim("  View it on your dashboard: ")}${color.frog(handoff.dashboardUrl)}\n`,
  );
  if (handoff.active) {
    process.stdout.write(color.dim("             auto sign-in link — valid for ~60s\n"));
  } else if (handoff.reason !== "disabled-flag" && handoff.reason !== "disabled-default") {
    process.stdout.write(color.dim("             sign-in link unavailable — log in on the web\n"));
  }
}
