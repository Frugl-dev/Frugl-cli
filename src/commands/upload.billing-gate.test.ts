import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { IncomingMessage, ServerResponse } from "node:http";
import { EXIT } from "../lib/exit-codes.js";
import { MockServer } from "../e2e/helpers/mock-server.js";
import { runCli } from "../e2e/helpers/spawn.js";
import { clearAuth, injectAuth, makeTestSession } from "../e2e/helpers/auth.js";
import { makeTempDir, writeTestSessions, type TempDir } from "../e2e/helpers/fixtures.js";
import { Temporal } from "temporal-polyfill";

// The billing gate (spec 060, T027/T028): when the server refuses an upload with
// a 429 { error: "org_blocked", ... }, the CLI surfaces the quota + upgrade link
// *before any bytes leave the machine* and exits cleanly (0) — it is an expected
// business state, not a failure. These tests drive the whole path through the
// real binary so the manifest gate, the warm render, and the exit code are all
// exercised together.
describe("frugl upload — billing gate (org_blocked)", { timeout: 30_000 }, () => {
  let server: MockServer;
  let home: TempDir;
  let manifestCalls: number;
  let presignCalls: number;
  let blockBody: Record<string, unknown>;

  beforeEach(async () => {
    manifestCalls = 0;
    presignCalls = 0;
    server = await new MockServer().start();
    // Registered first so it wins over wireHappyPath's manifest handler.
    server.on("POST", "/api/uploads/manifest", (_req: IncomingMessage, res: ServerResponse) => {
      manifestCalls += 1;
      server.json(res, 429, blockBody);
    });
    server.on("POST", "/api/uploads/:id/presign", (_req, res) => {
      presignCalls += 1;
      server.json(res, 200, {
        presigned_url: `${server.url}/never`,
        method: "PUT",
        headers: {},
        expires_at: Temporal.Now.instant()
          .add({ minutes: 1 })
          .toString({ smallestUnit: "millisecond" }),
      });
    });
    MockServer.wireHappyPath(server);
    home = await makeTempDir();
    injectAuth(makeTestSession(server.url));
  });

  afterEach(async () => {
    clearAuth(server.url);
    await home.cleanup();
    await server.close();
  });

  it("trial_expired: exits 0, shows the upgrade link, and never presigns", async () => {
    blockBody = {
      error: "org_blocked",
      reason: "trial_expired",
      used: 0,
      limit: 0,
      expires_at: "2026-07-03T00:00:00Z",
      // Relative on the wire — the CLI must resolve it against the endpoint.
      upgrade_url: "/acme/billing",
    };
    await writeTestSessions(home.dir, 2, "-Users-me-app");

    const { exitCode, stderr } = await runCli(["upload", "--yes", "--endpoint", server.url], {
      env: { FRUGL_HOME_DIR: home.dir },
    });

    expect(exitCode).toBe(EXIT.OK);
    // The gate fired at the manifest; not a single byte was presigned/PUT.
    expect(manifestCalls).toBe(1);
    expect(presignCalls).toBe(0);
    expect(stderr).toMatch(/trial has ended/i);
    expect(stderr).toContain(`${server.url}/acme/billing`);
    expect(stderr).toMatch(/Nothing was uploaded/i);
  });

  it("session_limit_reached: --format json emits a structured blocked marker", async () => {
    blockBody = {
      error: "org_blocked",
      reason: "session_limit_reached",
      used: 2500,
      limit: 2500,
      expires_at: "2026-07-01T00:00:00Z",
      // Absolute on the wire — must pass through unchanged.
      upgrade_url: "https://app.frugl.dev/acme/billing",
    };
    await writeTestSessions(home.dir, 2, "-Users-me-app");

    const { exitCode, stdout } = await runCli(
      ["upload", "--yes", "--format", "json", "--endpoint", server.url],
      { env: { FRUGL_HOME_DIR: home.dir } },
    );

    expect(exitCode).toBe(EXIT.OK);
    expect(presignCalls).toBe(0);
    const line = stdout.trim().split("\n").at(-1)!;
    const parsed = JSON.parse(line) as {
      command: string;
      ok: boolean;
      blocked: {
        reason: string;
        used: number;
        limit: number;
        expiresAt: string | null;
        upgradeUrl: string;
      };
    };
    expect(parsed.command).toBe("upload");
    expect(parsed.ok).toBe(true);
    expect(parsed.blocked).toEqual({
      reason: "session_limit_reached",
      used: 2500,
      limit: 2500,
      expiresAt: "2026-07-01T00:00:00Z",
      upgradeUrl: "https://app.frugl.dev/acme/billing",
    });
  });
});
