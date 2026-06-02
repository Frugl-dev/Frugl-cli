import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EXIT } from "../lib/exit-codes.js";
import { MockServer } from "../e2e/helpers/mock-server.js";
import { runCli } from "../e2e/helpers/spawn.js";
import { clearAuth, injectAuth, makeTestSession } from "../e2e/helpers/auth.js";
import { makeTempDir, type TempDir } from "../e2e/helpers/fixtures.js";
import { makeGitRepo, writeGitSession } from "../e2e/helpers/git-fixtures.js";

// FR-016 / SC-006: the --json additions are strictly additive — exact documented
// key sets when on, and omitted entirely when off (byte-for-byte default stream).
describe("--json gitContext additive contract (FR-016)", { timeout: 30_000 }, () => {
  let server: MockServer;
  let home: TempDir;
  let repo: TempDir;

  beforeEach(async () => {
    server = await new MockServer().start();
    MockServer.wireHappyPath(server);
    home = await makeTempDir();
    repo = await makeTempDir();
    await makeGitRepo(repo.dir, {
      originUrl: "https://github.com/acme/widgets.git",
      branch: "main",
    });
    await writeGitSession(home.dir, { cwd: repo.dir, gitBranch: "main" });
    injectAuth(makeTestSession(server.url));
  });

  afterEach(async () => {
    clearAuth(server.url);
    await home.cleanup();
    await repo.cleanup();
    await server.close();
  });

  function parseLines(stdout: string): Record<string, unknown>[] {
    return stdout
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l) as Record<string, unknown>);
  }

  it("--link-prs: upload-start + final summary gitContext have exactly the documented keys", async () => {
    const { exitCode, stdout } = await runCli(
      ["upload", "--confirm", "--link-prs", "--json", "--endpoint", server.url],
      { env: { FRUGL_HOME_DIR: home.dir } },
    );
    expect(exitCode).toBe(EXIT.OK);
    const lines = parseLines(stdout);

    const start = lines.find((l) => l["event"] === "upload-start")!;
    expect(Object.keys(start["gitContext"] as object).sort()).toEqual([
      "active",
      "repositories",
      "sessionsWithContext",
    ]);

    const summary = lines.at(-1)!;
    expect(Object.keys(summary["gitContext"] as object).sort()).toEqual([
      "active",
      "repositories",
      "sessionsWithContext",
    ]);
  });

  it("default off: neither upload-start nor the final summary carries gitContext", async () => {
    const { exitCode, stdout } = await runCli(
      ["upload", "--confirm", "--json", "--endpoint", server.url],
      { env: { FRUGL_HOME_DIR: home.dir } },
    );
    expect(exitCode).toBe(EXIT.OK);
    const lines = parseLines(stdout);
    const start = lines.find((l) => l["event"] === "upload-start")!;
    expect(start["gitContext"]).toBeUndefined();
    expect(lines.at(-1)!["gitContext"]).toBeUndefined();
  });
});
