import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { IncomingMessage, ServerResponse } from "node:http";
import { EXIT } from "../lib/exit-codes.js";
import { MockServer } from "../e2e/helpers/mock-server.js";
import { runCli } from "../e2e/helpers/spawn.js";
import { clearAuth, injectAuth, makeTestSession } from "../e2e/helpers/auth.js";
import { makeTempDir, writeTestSessions, type TempDir } from "../e2e/helpers/fixtures.js";

// `upload` must never capture a context-window snapshot — that belongs solely
// to `frugl context`. These tests lock in both halves of the contract: the
// `context` positional is gone, and a default run only ships sessions.
describe("frugl upload — no context snapshot", { timeout: 30_000 }, () => {
  let server: MockServer;
  let home: TempDir;
  let manifestCalls: number;
  let manifestSessions: Array<{ session_id: string }>;

  beforeEach(async () => {
    manifestCalls = 0;
    manifestSessions = [];
    server = await new MockServer().start();
    server.on(
      "POST",
      "/api/uploads/manifest",
      (_req: IncomingMessage, res: ServerResponse, _p, body: Buffer) => {
        manifestCalls += 1;
        manifestSessions = (
          JSON.parse(body.toString()) as { sessions: Array<{ session_id: string }> }
        ).sessions;
        server.json(res, 200, { upload_id: "mfst-1" });
      },
    );
    MockServer.wireHappyPath(server);
    home = await makeTempDir();
    injectAuth(makeTestSession(server.url));
  });

  afterEach(async () => {
    clearAuth(server.url);
    await home.cleanup();
    await server.close();
  });

  it("rejects the removed `context` target with a usage error", async () => {
    await writeTestSessions(home.dir, 1, "-Users-me-app");

    const { exitCode, stderr } = await runCli(
      ["upload", "context", "--yes", "--endpoint", server.url],
      { env: { FRUGL_HOME_DIR: home.dir } },
    );

    expect(exitCode).toBe(EXIT.USAGE);
    expect(stderr).toContain("Unknown upload target 'context'");
    // Nothing was uploaded — the run bailed before touching the cloud.
    expect(manifestCalls).toBe(0);
  });

  it("a default run ships sessions only — never snapshots the context window", async () => {
    await writeTestSessions(home.dir, 2, "-Users-me-app");

    const { exitCode, stdout, stderr } = await runCli(
      ["upload", "--yes", "--endpoint", server.url],
      { env: { FRUGL_HOME_DIR: home.dir } },
    );

    expect(exitCode).toBe(EXIT.OK);
    expect(manifestSessions.length).toBe(2);
    // Exactly one manifest: the sessions batch. A context snapshot would create
    // a second one against the same endpoint.
    expect(manifestCalls).toBe(1);
    // The snapshot banner (printed before capture, regardless of environment)
    // must never appear, and no snapshot receipt either.
    const out = stdout + stderr;
    expect(out).not.toMatch(/Snapshotting your context window/);
    expect(out).not.toMatch(/Context snapshot/);
  });
});
