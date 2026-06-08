import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readdir, readFile } from "node:fs/promises";
import type { ServerResponse } from "node:http";
import path from "node:path";
import { EXIT } from "../lib/exit-codes.js";
import { MockServer } from "../e2e/helpers/mock-server.js";
import { runCli } from "../e2e/helpers/spawn.js";
import { clearAuth, injectAuth, makeTestSession } from "../e2e/helpers/auth.js";
import { makeTempDir, type TempDir } from "../e2e/helpers/fixtures.js";
import { makeGitRepo, writeGitSession, FIXTURE_SHA } from "../e2e/helpers/git-fixtures.js";

const TOKEN = "ghp_PLANTEDinspecttoken1234567890";

describe(
  "frugl upload — --link-prs --dry-run --inspect audit (US3/SC-004)",
  { timeout: 30_000 },
  () => {
    let server: MockServer;
    let home: TempDir;
    let repo: TempDir;
    let inspect: TempDir;
    let uploadHits: number;

    beforeEach(async () => {
      uploadHits = 0;
      server = await new MockServer().start();
      const bump = (res: ServerResponse): void => {
        uploadHits += 1;
        server.json(res, 200, {});
      };
      server.on("POST", "/api/uploads/manifest", (_req, res) => bump(res));
      server.on("POST", "/api/uploads/:id/presign", (_req, res) => bump(res));
      server.on("POST", "/api/uploads/:id/complete", (_req, res) => bump(res));

      home = await makeTempDir();
      repo = await makeTempDir();
      inspect = await makeTempDir();
      // origin URL embeds a credential token; it must never reach the inspection output.
      await makeGitRepo(repo.dir, {
        originUrl: `https://x-access-token:${TOKEN}@github.com/acme/widgets.git`,
        branch: "main",
      });
      await writeGitSession(home.dir, { cwd: repo.dir, gitBranch: "main" });
      injectAuth(makeTestSession(server.url));
    });

    afterEach(async () => {
      clearAuth(server.url);
      await home.cleanup();
      await repo.cleanup();
      await inspect.cleanup();
      await server.close();
    });

    it("writes the would-be-transmitted git context, sends zero bytes, leaks no credential", async () => {
      const outDir = path.join(inspect.dir, "out");
      const { exitCode } = await runCli(
        ["upload", "--link-prs", "--dry-run", "--inspect", outDir, "--endpoint", server.url],
        { env: { FRUGL_HOME_DIR: home.dir } },
      );
      expect(exitCode).toBe(EXIT.OK);
      expect(uploadHits).toBe(0); // zero upload-endpoint requests (SC-004)

      // The resolved git context is written distinctly from the redacted payload.
      const gitContextRaw = await readFile(path.join(outDir, "git-context.json"), "utf8");
      const gitContext = JSON.parse(gitContextRaw);
      expect(gitContext.sessions).toHaveLength(1);
      expect(gitContext.sessions[0].gitContext).toEqual({
        repository: { host: "github.com", owner: "acme", name: "widgets" },
        branch: "main",
        commitSha: FIXTURE_SHA,
      });

      // The planted credential token appears in NONE of the inspection files (SC-003).
      const files = await readdir(outDir);
      const allContents = await Promise.all(
        files.map((file) => readFile(path.join(outDir, file), "utf8")),
      );
      for (const contents of allContents) {
        expect(contents).not.toContain(TOKEN);
      }
    });
  },
);
