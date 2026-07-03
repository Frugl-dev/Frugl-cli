import { randomUUID } from "node:crypto";
import {
  requestHandoffUrl,
  resolveHandoffPreference,
  type HandoffResult,
} from "../cloud/handoff.js";
import type { OutputMode } from "../lib/output-mode.js";
import { color, symbol } from "../lib/theme.js";
import { formatLocalDateTime } from "../lib/time.js";
import { HttpCloudAdapter } from "../upload/cloud-http-adapter.js";
import type { SnapshotRunContext } from "../snapshot/shared.js";
import { captureMcpInventory, MCP_SOURCE_TOOL } from "./capture.js";
import { buildMcpPayload } from "./payload.js";
import { uploadMcpSnapshot } from "./upload.js";

// A finished mcp snapshot, ready to print.
export type McpReport =
  | {
      status: "uploaded";
      capturedAt: string;
      serverCount: number;
      parseStatus: "parsed" | "unparsed";
      manifestId: string;
      sessionId: string;
      policyVersion: string;
      byteSize: number;
      handoff: HandoffResult;
    }
  | { status: "no_change" }
  | { status: "cap_reached"; cap: number; used: number; windowResetsAt: string };

// Capture, anonymize, and upload an MCP snapshot. Throws (fail-closed) on a
// missing/failed `claude` or any upload failure — the caller decides how to
// surface it. The gate outcomes (no_change / cap_reached) are normal results.
export async function runMcpSnapshot(ctx: SnapshotRunContext): Promise<McpReport> {
  const inventory = captureMcpInventory();

  const homeDir = process.env["FRUGL_HOME_DIR"];
  const payload = buildMcpPayload(inventory, {
    uploadId: randomUUID(),
    ownerEmail: ctx.session.email,
    ...(homeDir !== undefined ? { homeDir } : {}),
  });

  const cloud = new HttpCloudAdapter(ctx.client);
  const upload = await uploadMcpSnapshot({
    cloud,
    cliVersion: ctx.client.cliVersion,
    sourceKind: MCP_SOURCE_TOOL,
    capturedAt: inventory.capturedAt,
    payload,
  });

  if (upload.status === "no_change") return { status: "no_change" };
  if (upload.status === "cap_reached") {
    return {
      status: "cap_reached",
      cap: upload.cap,
      used: upload.used,
      windowResetsAt: upload.windowResetsAt,
    };
  }

  const handoff = await requestHandoffUrl(
    ctx.client,
    upload.dashboardUrl,
    resolveHandoffPreference(undefined, Boolean(process.stdout.isTTY), ctx.mode),
  );

  return {
    status: "uploaded",
    capturedAt: inventory.capturedAt,
    serverCount: inventory.mcpServers.length,
    parseStatus: inventory.parseStatus,
    manifestId: upload.manifestId,
    sessionId: upload.sessionId,
    policyVersion: payload.policyVersion,
    byteSize: payload.byteSize,
    handoff,
  };
}

export function reportMcp(report: McpReport, mode: OutputMode): void {
  if (report.status === "no_change") {
    if (mode === "json") {
      process.stdout.write(
        `${JSON.stringify({ command: "mcp", ok: true, status: "no_change", tool: MCP_SOURCE_TOOL })}\n`,
      );
      return;
    }
    process.stdout.write(
      `${color.dim(`${symbol.tick} No change since your last MCP snapshot — nothing uploaded`)}\n`,
    );
    return;
  }

  if (report.status === "cap_reached") {
    if (mode === "json") {
      process.stdout.write(
        `${JSON.stringify({
          command: "mcp",
          ok: true,
          status: "cap_reached",
          tool: MCP_SOURCE_TOOL,
          cap: report.cap,
          used: report.used,
          windowResetsAt: report.windowResetsAt,
        })}\n`,
      );
      return;
    }
    process.stdout.write(
      `${color.dim(`${symbol.tick} Weekly snapshot limit reached (${report.used}/${report.cap}) — nothing uploaded`)}\n`,
    );
    process.stdout.write(`${color.dim(`  Resets ${report.windowResetsAt}`)}\n`);
    return;
  }

  if (mode === "json") {
    process.stdout.write(
      `${JSON.stringify({
        command: "mcp",
        ok: true,
        status: "uploaded",
        tool: MCP_SOURCE_TOOL,
        capturedAt: report.capturedAt,
        serverCount: report.serverCount,
        parseStatus: report.parseStatus,
        manifestId: report.manifestId,
        sessionId: report.sessionId,
        redactionPolicyVersion: report.policyVersion,
        byteSize: report.byteSize,
        dashboardUrl: report.handoff.dashboardUrl,
      })}\n`,
    );
    return;
  }

  const servers = `${report.serverCount} server${report.serverCount === 1 ? "" : "s"}`;
  process.stdout.write(
    `${color.ok(`${symbol.tick} MCP snapshot captured`)} ${color.dim(`(${servers}) at ${formatLocalDateTime(report.capturedAt)}`)}\n`,
  );
  process.stdout.write(`${color.dim("  Dashboard: ")}${color.frog(report.handoff.dashboardUrl)}\n`);
  if (report.handoff.active) {
    process.stdout.write(color.dim("             auto sign-in link — valid for ~60s\n"));
  } else if (
    report.handoff.reason !== "disabled-flag" &&
    report.handoff.reason !== "disabled-default"
  ) {
    process.stdout.write(color.dim("             sign-in link unavailable — log in on the web\n"));
  }
}
