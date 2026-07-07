import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EXIT } from "../lib/exit-codes.js";
import { MockServer } from "../e2e/helpers/mock-server.js";
import { runCli } from "../e2e/helpers/spawn.js";
import { clearAuth, injectAuth, makeTestSession } from "../e2e/helpers/auth.js";
import { makeTempDir, writeTestSessions, type TempDir } from "../e2e/helpers/fixtures.js";

// Regression: a bare `frugl upload` (no --endpoint) in a directory carrying a
// `.frugl.json` endpoint pin must resolve the PINNED endpoint, exactly like
// `whoami`/`init` do. The command used to resolve with only { flag, env }, so a
// pinned self-host repo's bare upload silently resolved to the public cloud
// (auth-failed there, or — worse — uploaded to it when a prod session existed).
//
// Auth is endpoint-scoped, which gives a clean, scope-independent signal: with a
// session injected ONLY for the mock (pinned) endpoint, a bare upload that
// HONORS the pin authenticates and proceeds (exit OK); one that IGNORES it falls
// through to the public default, finds no session there, and exits AUTH_FAILURE.
describe("frugl upload — honors the .frugl.json endpoint pin", { timeout: 30_000 }, () => {
  let server: MockServer;
  let home: TempDir;
  let pinnedDir: string;
  let unpinnedDir: string;

  beforeEach(async () => {
    server = await new MockServer().start();
    MockServer.wireHappyPath(server);
    home = await makeTempDir();
    // A session that ONLY authenticates against the mock endpoint.
    injectAuth(makeTestSession(server.url));
    // Some real sessions to discover, so the run gets past detection.
    await writeTestSessions(home.dir, 1, "-Users-me-app");

    pinnedDir = await mkdtemp(join(tmpdir(), "frugl-pinned-"));
    await writeFile(
      join(pinnedDir, ".frugl.json"),
      JSON.stringify({ version: 1, endpoint: server.url, org: "my-company" }),
    );
    unpinnedDir = await mkdtemp(join(tmpdir(), "frugl-unpinned-"));
  });

  afterEach(async () => {
    clearAuth(server.url);
    await home.cleanup();
    await rm(pinnedDir, { recursive: true, force: true });
    await rm(unpinnedDir, { recursive: true, force: true });
    await server.close();
  });

  it("resolves the pinned endpoint and authenticates there (no --endpoint flag)", async () => {
    const { exitCode } = await runCli(["upload", "--yes", "--format", "json"], {
      cwd: pinnedDir,
      env: { FRUGL_HOME_DIR: home.dir },
    });
    // Auth against the pinned mock endpoint succeeds; the run proceeds and exits
    // cleanly (the mock endpoint's own sessions are out of this project's scope,
    // so nothing uploads — but crucially it did NOT auth-fail against the cloud).
    expect(exitCode).toBe(EXIT.OK);
  });

  it("control: without the pin, the same bare upload falls through to the cloud and auth-fails", async () => {
    const { exitCode } = await runCli(["upload", "--yes", "--format", "json"], {
      cwd: unpinnedDir,
      env: { FRUGL_HOME_DIR: home.dir },
    });
    // No pin, no --endpoint, no FRUGL_ENDPOINT → the public default, where the
    // injected (mock-scoped) session does not apply.
    expect(exitCode).toBe(EXIT.AUTH_FAILURE);
  });
});
