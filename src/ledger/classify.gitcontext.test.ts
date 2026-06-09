import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EXIT } from "../lib/exit-codes.js";
import { MockServer } from "../e2e/helpers/mock-server.js";
import { runCli } from "../e2e/helpers/spawn.js";
import { clearAuth, injectAuth, makeTestSession } from "../e2e/helpers/auth.js";
import { makeTempDir, type TempDir } from "../e2e/helpers/fixtures.js";
import { makeGitRepo, writeGitSession } from "../e2e/helpers/git-fixtures.js";

// SC-007: git context is manifest metadata, excluded from the redacted payload's
// contentHash, so toggling --link-prs does not reclassify an unchanged session.
describe("ledger: --link-prs does not churn the ledger (SC-007)", { timeout: 30_000 }, () => {
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

  it("upload without --link-prs, then re-run WITH --link-prs → session is unchanged (skipped)", async () => {
    const env = { FRUGL_HOME_DIR: home.dir };

    const first = await runCli(
      ["upload", "--sessions", "--yes", "--json", "--endpoint", server.url],
      {
        env,
      },
    );
    expect(first.exitCode).toBe(EXIT.OK);
    const firstResult = JSON.parse(first.stdout.trim().split("\n").findLast(Boolean)!);
    expect(firstResult.actualSessionCount).toBe(1);

    const second = await runCli(
      ["upload", "--sessions", "--yes", "--link-prs", "--json", "--endpoint", server.url],
      {
        env,
      },
    );
    expect(second.exitCode).toBe(EXIT.OK);
    const secondResult = JSON.parse(second.stdout.trim().split("\n").findLast(Boolean)!);
    // Unchanged → no re-upload, despite --link-prs now being on.
    expect(secondResult.noop).toBe(true);
    expect(secondResult.classification.unchanged).toBe(1);
  });
});
