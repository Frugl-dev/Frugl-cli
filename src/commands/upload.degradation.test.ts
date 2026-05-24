import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { IncomingMessage, ServerResponse } from "node:http";
import path from "node:path";
import { EXIT } from "../lib/exit-codes.js";
import { MockServer } from "../e2e/helpers/mock-server.js";
import { runCli } from "../e2e/helpers/spawn.js";
import { clearAuth, injectAuth, makeTestSession } from "../e2e/helpers/auth.js";
import { makeTempDir, type TempDir } from "../e2e/helpers/fixtures.js";
import { makeGitRepo, writeGitSession } from "../e2e/helpers/git-fixtures.js";

interface ManifestSession {
  session_id: string;
  git_context?: unknown;
}

describe("poppi upload — best-effort degradation (US4/SC-005)", { timeout: 30_000 }, () => {
  let server: MockServer;
  let home: TempDir;
  let repo: TempDir;
  let manifestSessions: ManifestSession[];

  beforeEach(async () => {
    manifestSessions = [];
    server = await new MockServer().start();
    server.on(
      "POST",
      "/api/uploads/manifest",
      (_req: IncomingMessage, res: ServerResponse, _p, body: Buffer) => {
        manifestSessions = (JSON.parse(body.toString()) as { sessions: ManifestSession[] })
          .sessions;
        server.json(res, 200, { upload_id: "mfst-1" });
      },
    );
    MockServer.wireHappyPath(server);

    home = await makeTempDir();
    repo = await makeTempDir();
    injectAuth(makeTestSession(server.url));
  });

  afterEach(async () => {
    clearAuth(server.url);
    await home.cleanup();
    await repo.cleanup();
    await server.close();
  });

  it("a mixed batch exits success; only resolvable sessions carry context; no payload dropped", async () => {
    // (a) clean repo + remote → resolves; (b) not-a-repo dir; (c) missing dir.
    await makeGitRepo(repo.dir, {
      originUrl: "https://github.com/acme/widgets.git",
      branch: "main",
    });
    await writeGitSession(home.dir, { cwd: repo.dir, gitBranch: "main", projName: "p-resolved" });
    await writeGitSession(home.dir, { cwd: home.dir, projName: "p-not-a-repo" }); // home.dir is not a repo
    await writeGitSession(home.dir, {
      cwd: path.join(repo.dir, "gone"),
      projName: "p-missing",
    });

    const { exitCode } = await runCli(
      ["upload", "--confirm", "--link-prs", "--endpoint", server.url],
      { env: { POPPI_HOME_DIR: home.dir } },
    );
    expect(exitCode).toBe(EXIT.OK); // never fatal (no new exit code)

    // All three sessions are in the manifest (none dropped because git failed)…
    expect(manifestSessions.length).toBe(3);
    // …but exactly one carries git context (the resolvable repo).
    const withContext = manifestSessions.filter((s) => s.git_context !== undefined);
    expect(withContext.length).toBe(1);
  });

  it("flag on but zero sessions resolve → single notice, exit success", async () => {
    // Only a not-a-repo session: nothing resolves.
    await writeGitSession(home.dir, { cwd: home.dir, projName: "p-none" });

    const { exitCode, stderr } = await runCli(
      ["upload", "--confirm", "--link-prs", "--endpoint", server.url],
      { env: { POPPI_HOME_DIR: home.dir } },
    );
    expect(exitCode).toBe(EXIT.OK);
    const notices = stderr.match(/no sessions had resolvable git context/g) ?? [];
    expect(notices.length).toBe(1); // fires at most once
    expect(manifestSessions.length).toBe(1);
    expect(manifestSessions[0]!.git_context).toBeUndefined();
  });
});
