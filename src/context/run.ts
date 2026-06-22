import { randomUUID } from "node:crypto";
import { anonymize } from "../anonymize/index.js";
import { captureDeclaredMcpServers } from "../capture/claude/mcp-inventory.js";
import {
  requestHandoffUrl,
  resolveHandoffPreference,
  type HandoffResult,
} from "../cloud/handoff.js";
import type { OutputMode } from "../lib/output-mode.js";
import { color, symbol } from "../lib/theme.js";
import { HttpCloudAdapter } from "../upload/cloud-http-adapter.js";
import type { SnapshotRunContext } from "../snapshot/shared.js";
import { captureContext } from "./capture.js";
import { parseSkillScopesFromContext } from "./skill-scopes.js";
import { uploadContextSnapshot } from "./upload.js";

// v1 has no built-in scheduler. To capture snapshots on a cadence, drive
// `frugl snapshot context` from an external cron/CI job (see README). The tool
// is the configured AI tool whose /context breakdown is captured; today only
// Claude Code is wired.
const TOOL = "claude-code";

// A finished context snapshot, ready to print. Mirrors the upload result but
// also carries the handoff + capture details the reporter needs.
export type ContextReport =
  | {
      status: "uploaded";
      capturedAt: string;
      manifestId: string;
      sessionId: string;
      policyVersion: string;
      byteSize: number;
      handoff: HandoffResult;
    }
  | { status: "no_change" }
  | { status: "cap_reached"; cap: number; used: number; windowResetsAt: string };

// Capture, anonymize, and upload a context snapshot. Throws (fail-closed) on any
// capture/anonymize/upload failure — the caller decides how to surface it. A
// successful run returns a report; the gate outcomes (no_change / cap_reached)
// are normal, non-error results.
export async function runContextSnapshot(ctx: SnapshotRunContext): Promise<ContextReport> {
  // 1) Capture (fail-closed): missing binary / non-zero exit / empty stdout each
  // throw before any upload. capturedAt is stamped at capture time.
  const capture = captureContext(TOOL);

  // 2) Anonymize the captured TEXT client-side (fail-closed). The home prefix is
  // normalized and embedded secrets/emails are redacted; skill/MCP/agent names
  // and memory-file paths are preserved as config identifiers.
  const homeDir = process.env["FRUGL_HOME_DIR"];
  // Local-only random salt. The pseudonym HMAC key must never equal a value that
  // ships in the manifest (capturedAt does), or pseudonyms become
  // dictionary-reversible by anyone holding the payload.
  const result = anonymize(capture.text, {
    uploadId: randomUUID(),
    ownerEmail: ctx.session.email,
    ...(homeDir !== undefined ? { homeDir } : {}),
  });

  // 3) Upload via the manifest -> presign -> PUT -> complete handshake. The
  // declared MCP inventory (names-only, fail-open) rides the manifest: a failed
  // `claude mcp list` simply omits it, never blocking the snapshot.
  const cloud = new HttpCloudAdapter(ctx.client);
  const mcpServers = captureDeclaredMcpServers();
  // Skill scopes ride the manifest too (fail-open): parse from the anonymized
  // payload — the exact bytes the server parses for skill items — so the names
  // line up 1:1. A capture with no scope-bearing skills yields null and the
  // field is omitted.
  const skillScopes = parseSkillScopesFromContext(String(result.payload), capture.capturedAt);
  const upload = await uploadContextSnapshot({
    cloud,
    cliVersion: ctx.client.cliVersion,
    sourceKind: TOOL,
    policyVersion: result.policyVersion,
    capturedAt: capture.capturedAt,
    anonymization: result,
    ...(mcpServers ? { mcpServers } : {}),
    ...(skillScopes ? { skillScopes } : {}),
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
    capturedAt: capture.capturedAt,
    manifestId: upload.manifestId,
    sessionId: upload.sessionId,
    policyVersion: result.policyVersion,
    byteSize: result.byteSize,
    handoff,
  };
}

// Print a context report. Snapshot gate outcomes (spec 052) report clearly and
// exit 0 (no dashboard handoff, since nothing was uploaded).
export function reportContext(report: ContextReport, mode: OutputMode): void {
  if (report.status === "no_change") {
    if (mode === "json") {
      process.stdout.write(
        `${JSON.stringify({ command: "context", ok: true, status: "no_change", tool: TOOL })}\n`,
      );
      return;
    }
    process.stdout.write(
      `${color.dim(`${symbol.tick} No change since your last context snapshot — nothing uploaded`)}\n`,
    );
    return;
  }

  if (report.status === "cap_reached") {
    if (mode === "json") {
      process.stdout.write(
        `${JSON.stringify({
          command: "context",
          ok: true,
          status: "cap_reached",
          tool: TOOL,
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
        command: "context",
        ok: true,
        status: "uploaded",
        tool: TOOL,
        capturedAt: report.capturedAt,
        manifestId: report.manifestId,
        sessionId: report.sessionId,
        redactionPolicyVersion: report.policyVersion,
        byteSize: report.byteSize,
        dashboardUrl: report.handoff.dashboardUrl,
      })}\n`,
    );
    return;
  }

  process.stdout.write(
    `${color.ok(`${symbol.tick} Context snapshot captured`)} ${color.dim(`at ${report.capturedAt}`)}\n`,
  );
  process.stdout.write(
    `${color.dim("  View it on your dashboard: ")}${color.frog(report.handoff.dashboardUrl)}\n`,
  );
  if (report.handoff.active) {
    process.stdout.write(color.dim("             auto sign-in link — valid for ~60s\n"));
  } else if (
    report.handoff.reason !== "disabled-flag" &&
    report.handoff.reason !== "disabled-default"
  ) {
    process.stdout.write(color.dim("             sign-in link unavailable — log in on the web\n"));
  }
}
