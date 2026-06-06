import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { IncomingMessage, ServerResponse } from "node:http";
import { EXIT } from "../lib/exit-codes.js";
import { MockServer } from "../e2e/helpers/mock-server.js";
import { runCli } from "../e2e/helpers/spawn.js";
import { clearAuth, injectAuth, makeTestSession } from "../e2e/helpers/auth.js";
import { makeTempDir, writeTestSessions, type TempDir } from "../e2e/helpers/fixtures.js";

interface FinalSummary {
  command: string;
  ok: boolean;
  dashboardUrl: string;
  handoff?: { active: true; expiresAt: string } | { active: false; reason: string };
}

// The final-summary line is the NDJSON object with command:"upload" (progress
// events carry `event` instead).
function finalSummary(stdout: string): FinalSummary {
  const lines = stdout.trim().split("\n");
  for (const line of lines.toReversed()) {
    try {
      const parsed = JSON.parse(line) as Record<string, unknown>;
      if (parsed["command"] === "upload") return parsed as unknown as FinalSummary;
    } catch {
      // human/preview line — skip
    }
  }
  throw new Error(`no final summary in stdout:\n${stdout}`);
}

describe("frugl upload — CLI→web handoff (006)", { timeout: 30_000 }, () => {
  let server: MockServer;
  let home: TempDir;
  let handoffCalls: Array<{ redirect_to?: string }>;

  const EXPIRES = "2026-06-06T12:01:00.000Z";

  function wireHandoff(): void {
    server.on(
      "POST",
      "/api/auth/handoff",
      (_req: IncomingMessage, res: ServerResponse, _p, body: Buffer) => {
        handoffCalls.push(JSON.parse(body.toString()) as { redirect_to?: string });
        server.json(res, 201, { code: "hof_test_code", expires_at: EXPIRES });
      },
    );
  }

  beforeEach(async () => {
    handoffCalls = [];
    server = await new MockServer().start();
    MockServer.wireHappyPath(server);
    home = await makeTempDir();
    await writeTestSessions(home.dir, 1, "handoff-proj");
    injectAuth(makeTestSession(server.url));
  });

  afterEach(async () => {
    clearAuth(server.url);
    await home.cleanup();
    await server.close();
  });

  it("--handoff mints a code, sends path+query redirect_to, decorates dashboardUrl (US1)", async () => {
    wireHandoff();
    const { exitCode, stdout } = await runCli(
      ["upload", "--confirm", "--json", "--handoff", "--endpoint", server.url],
      { env: { FRUGL_HOME_DIR: home.dir } },
    );
    expect(exitCode).toBe(EXIT.OK);

    // redirect_to is the dashboard path, never the host (open-redirect guard).
    expect(handoffCalls.length).toBe(1);
    expect(handoffCalls[0]!.redirect_to).toMatch(/^\/dashboard\//);

    const summary = finalSummary(stdout);
    expect(summary.ok).toBe(true);
    expect(summary.dashboardUrl).toContain("?handoff=hof_test_code");
    expect(summary.handoff).toEqual({ active: true, expiresAt: EXPIRES });
  });

  it("endpoint not deployed (404) degrades: exit OK, plain URL, reason unsupported (US3)", async () => {
    // No handoff route wired — MockServer answers 404.
    const { exitCode, stdout } = await runCli(
      ["upload", "--confirm", "--json", "--handoff", "--endpoint", server.url],
      { env: { FRUGL_HOME_DIR: home.dir } },
    );
    expect(exitCode).toBe(EXIT.OK);
    const summary = finalSummary(stdout);
    expect(summary.ok).toBe(true);
    expect(summary.dashboardUrl).not.toContain("handoff=");
    expect(summary.handoff).toEqual({ active: false, reason: "unsupported" });
  });

  it("server error (500) degrades: exit OK, plain URL, reason unavailable (US3)", async () => {
    server.on("POST", "/api/auth/handoff", (_req, res) => {
      server.json(res, 500, { error: "boom" });
    });
    const { exitCode, stdout } = await runCli(
      ["upload", "--confirm", "--json", "--handoff", "--endpoint", server.url],
      { env: { FRUGL_HOME_DIR: home.dir } },
    );
    expect(exitCode).toBe(EXIT.OK);
    const summary = finalSummary(stdout);
    expect(summary.ok).toBe(true);
    expect(summary.dashboardUrl).not.toContain("handoff=");
    expect(summary.handoff).toEqual({ active: false, reason: "unavailable" });
  });

  it("--no-handoff makes zero wire calls and reports disabled-flag (US4)", async () => {
    wireHandoff();
    const { exitCode, stdout } = await runCli(
      ["upload", "--confirm", "--json", "--no-handoff", "--endpoint", server.url],
      { env: { FRUGL_HOME_DIR: home.dir } },
    );
    expect(exitCode).toBe(EXIT.OK);
    expect(handoffCalls).toEqual([]);
    const summary = finalSummary(stdout);
    expect(summary.dashboardUrl).not.toContain("handoff=");
    expect(summary.handoff).toEqual({ active: false, reason: "disabled-flag" });
  });

  it("--json without the flag defaults off: no wire call, no handoff key (US4)", async () => {
    wireHandoff();
    const { exitCode, stdout } = await runCli(
      ["upload", "--confirm", "--json", "--endpoint", server.url],
      { env: { FRUGL_HOME_DIR: home.dir } },
    );
    expect(exitCode).toBe(EXIT.OK);
    expect(handoffCalls).toEqual([]);
    const summary = finalSummary(stdout);
    expect(summary.dashboardUrl).not.toContain("handoff=");
    expect("handoff" in summary).toBe(false); // byte-identical default-off path
  });

  it("text mode via pipe (non-TTY) defaults off but still prints the Dashboard line (US4/T008)", async () => {
    wireHandoff();
    const { exitCode, stderr } = await runCli(["upload", "--confirm", "--endpoint", server.url], {
      env: { FRUGL_HOME_DIR: home.dir },
    });
    expect(exitCode).toBe(EXIT.OK);
    expect(handoffCalls).toEqual([]); // spawned stdout is a pipe → default off
    expect(stderr).toContain("Dashboard:");
    expect(stderr).not.toContain("handoff=");
  });

  it("--dry-run never mints, even with --handoff (US1)", async () => {
    wireHandoff();
    const { exitCode, stdout } = await runCli(
      ["upload", "--dry-run", "--confirm", "--json", "--handoff", "--endpoint", server.url],
      { env: { FRUGL_HOME_DIR: home.dir } },
    );
    expect(exitCode).toBe(EXIT.OK);
    expect(handoffCalls).toEqual([]);
    const summary = finalSummary(stdout);
    expect(summary.dashboardUrl).not.toContain("handoff=");
    expect("handoff" in summary).toBe(false);
  });
});
