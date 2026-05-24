import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { IncomingMessage, ServerResponse } from "node:http";
import { EXIT } from "../lib/exit-codes.js";
import { MockServer } from "../e2e/helpers/mock-server.js";
import { runCli } from "../e2e/helpers/spawn.js";
import { clearAuth, injectAuth, makeTestSession } from "../e2e/helpers/auth.js";
import { makeTempDir, type TempDir } from "../e2e/helpers/fixtures.js";
import { makeGitRepo, writeGitSession, FIXTURE_SHA } from "../e2e/helpers/git-fixtures.js";

interface ManifestSession {
  session_id: string;
  git_context?: unknown;
}

describe("poppi upload — git-context opt-in wiring (US1/US2)", { timeout: 30_000 }, () => {
  let server: MockServer;
  let home: TempDir;
  let repo: TempDir;
  let manifestSessions: ManifestSession[];

  beforeEach(async () => {
    manifestSessions = [];
    server = await new MockServer().start();
    // Record the manifest-create body, registered BEFORE wireHappyPath so it wins.
    server.on(
      "POST",
      "/api/uploads/manifest",
      (_req: IncomingMessage, res: ServerResponse, _params, body: Buffer) => {
        const parsed = JSON.parse(body.toString()) as { sessions: ManifestSession[] };
        manifestSessions = parsed.sessions;
        server.json(res, 200, { upload_id: "mfst-1" });
      },
    );
    MockServer.wireHappyPath(server);

    home = await makeTempDir();
    repo = await makeTempDir();
    await makeGitRepo(repo.dir, {
      originUrl: "https://github.com/acme/widgets.git",
      branch: "feature-x",
    });
    await writeGitSession(home.dir, { cwd: repo.dir, gitBranch: "feature-x" });
    injectAuth(makeTestSession(server.url));
  });

  afterEach(async () => {
    clearAuth(server.url);
    await home.cleanup();
    await repo.cleanup();
    await server.close();
  });

  it("default (no --link-prs): NO git field is attached, even for a session in a real repo (SC-001)", async () => {
    const { exitCode, stdout } = await runCli(["upload", "--confirm", "--endpoint", server.url], {
      env: { POPPI_HOME_DIR: home.dir },
    });
    expect(exitCode).toBe(EXIT.OK);
    expect(manifestSessions.length).toBe(1);
    for (const s of manifestSessions) {
      expect(s.git_context).toBeUndefined();
    }
    // The final --json summary carries no gitContext block when off.
    const summary = JSON.parse(stdout.trim().split("\n").filter(Boolean).at(-1)!);
    expect(summary.gitContext).toBeUndefined();
  });

  it("--link-prs: attaches the credential-stripped git context to the manifest (US1)", async () => {
    const { exitCode } = await runCli(
      ["upload", "--confirm", "--link-prs", "--endpoint", server.url],
      { env: { POPPI_HOME_DIR: home.dir } },
    );
    expect(exitCode).toBe(EXIT.OK);
    expect(manifestSessions.length).toBe(1);
    expect(manifestSessions[0]!.git_context).toEqual({
      repository: { host: "github.com", owner: "acme", name: "widgets" },
      branch: "feature-x",
      commit_sha: FIXTURE_SHA,
    });
  });

  it("--link-prs --json: upload-start + final summary carry an additive gitContext", async () => {
    const { exitCode, stdout } = await runCli(
      ["upload", "--confirm", "--link-prs", "--json", "--endpoint", server.url],
      { env: { POPPI_HOME_DIR: home.dir } },
    );
    expect(exitCode).toBe(EXIT.OK);
    const lines = stdout
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l) as Record<string, unknown>);
    const start = lines.find((l) => l["event"] === "upload-start");
    expect(start!["gitContext"]).toEqual({
      active: true,
      sessionsWithContext: 1,
      repositories: ["acme/widgets"],
    });
    const summary = lines.at(-1)!;
    expect(summary["gitContext"]).toMatchObject({ active: true, sessionsWithContext: 1 });
  });
});
