import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { IncomingMessage, ServerResponse } from "node:http";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { EXIT } from "../lib/exit-codes.js";
import { MockServer } from "../e2e/helpers/mock-server.js";
import { runCli } from "../e2e/helpers/spawn.js";
import { clearAuth, injectAuth, makeTestSession } from "../e2e/helpers/auth.js";
import { makeTempDir, writeTestSessions, type TempDir } from "../e2e/helpers/fixtures.js";

// `frugl init` is the one-command front door: auth → org → write .frugl.json →
// upload → snapshot. These spawn the real CLI (so upload/snapshot run for real
// against a MockServer) and assert the config file the command leaves behind,
// plus the skip/merge/conflict behavior. A keychain session is injected so the
// auth step is reused (no OTP). `--cwd` (the temp dir) is where .frugl.json is
// written, kept well away from the repo.

interface OrgMeBody {
  org: { id: string; name: string; slug: string };
  membership: { role: string };
}
const ACME: OrgMeBody = {
  org: { id: "o1", name: "Acme", slug: "acme" },
  membership: { role: "owner" },
};

function wireOrgMe(server: MockServer, body: OrgMeBody | "none"): void {
  server.on("GET", "/api/orgs/me", (_req: IncomingMessage, res: ServerResponse) => {
    if (body === "none") {
      server.json(res, 409, { error: "org_required" });
      return;
    }
    server.json(res, 200, body);
  });
}

const CONFIG = ".frugl.json";

describe("frugl init", { timeout: 30_000 }, () => {
  let server: MockServer;
  let home: TempDir;
  let project: TempDir;
  let manifestCalls: number;

  beforeEach(async () => {
    manifestCalls = 0;
    server = await new MockServer().start();
    server.on("POST", "/api/uploads/manifest", (_req: IncomingMessage, res: ServerResponse) => {
      manifestCalls += 1;
      server.json(res, 200, { upload_id: "mfst-1" });
    });
    server
      .on("POST", "/api/uploads/:id/presign", (_req, res, params) => {
        server.json(res, 200, {
          presigned_url: `${server.url}/fake-put/${encodeURIComponent(params["id"] ?? "")}`,
          method: "PUT",
          headers: {},
          expires_at: new Date(Date.now() + 60_000).toISOString(),
        });
      })
      .on("PUT", "/fake-put/:id", (_req, res) => {
        res.writeHead(200).end();
      })
      .on("POST", "/api/uploads/:id/complete", (_req, res) => {
        server.json(res, 200, {
          manifest_id: "mfst-1",
          dashboard_url: `${server.url}/dashboard/mfst-1`,
        });
      });

    home = await makeTempDir();
    project = await makeTempDir();
    injectAuth(makeTestSession(server.url));
  });

  afterEach(async () => {
    clearAuth(server.url);
    await home.cleanup();
    await project.cleanup();
    await server.close();
  });

  function configPath(): string {
    return path.join(project.dir, CONFIG);
  }
  function readConfig(): Record<string, unknown> {
    return JSON.parse(readFileSync(configPath(), "utf8"));
  }

  it("--yes happy path: writes .frugl.json and runs the upload", async () => {
    wireOrgMe(server, "none");
    server.on("POST", "/api/orgs/create", (_req, res) => {
      server.json(res, 200, { org: { id: "o1", name: "Acme", slug: "acme" } });
    });
    await writeTestSessions(home.dir, 2, "-Users-me-app");

    const { exitCode } = await runCli(
      [
        "init",
        "--yes",
        "--org-name",
        "Acme",
        "--no-snapshot",
        "--format",
        "json",
        "--endpoint",
        server.url,
      ],
      { env: { FRUGL_HOME_DIR: home.dir }, cwd: project.dir },
    );

    expect(exitCode).toBe(EXIT.OK);
    const cfg = readConfig();
    expect(cfg["version"]).toBe(1);
    expect(cfg["org"]).toBe("acme");
    // A non-default (flag) endpoint is pinned (FR-007).
    expect(cfg["endpoint"]).toBe(server.url);
    // The upload step actually ran.
    expect(manifestCalls).toBeGreaterThanOrEqual(1);
  });

  it("--no-upload --no-snapshot still writes config but skips the upload", async () => {
    wireOrgMe(server, "none");
    server.on("POST", "/api/orgs/create", (_req, res) => {
      server.json(res, 200, { org: { id: "o1", name: "Acme", slug: "acme" } });
    });

    const { exitCode } = await runCli(
      [
        "init",
        "--yes",
        "--org-name",
        "Acme",
        "--no-upload",
        "--no-snapshot",
        "--endpoint",
        server.url,
      ],
      { env: { FRUGL_HOME_DIR: home.dir }, cwd: project.dir },
    );

    expect(exitCode).toBe(EXIT.OK);
    expect(readConfig()["org"]).toBe("acme");
    expect(manifestCalls).toBe(0);
  });

  it("re-running is byte-stable (no spurious diff)", async () => {
    wireOrgMe(server, ACME); // already-setup → deterministic slug both runs
    const args = ["init", "--yes", "--no-upload", "--no-snapshot", "--endpoint", server.url];
    const env = { env: { FRUGL_HOME_DIR: home.dir }, cwd: project.dir };

    const first = await runCli(args, env);
    expect(first.exitCode).toBe(EXIT.OK);
    const afterFirst = readFileSync(configPath(), "utf8");

    const second = await runCli(args, env);
    expect(second.exitCode).toBe(EXIT.OK);
    expect(readFileSync(configPath(), "utf8")).toBe(afterFirst);
  });

  it("--yes overwrites a conflicting existing value without prompting (FR-009)", async () => {
    wireOrgMe(server, ACME); // resolves org → "acme"
    // Pre-existing config pins a DIFFERENT org.
    writeFileSync(
      configPath(),
      `${JSON.stringify({ $schema: "x", version: 1, org: "old" }, null, 2)}\n`,
      "utf8",
    );

    const { exitCode } = await runCli(
      ["init", "--yes", "--no-upload", "--no-snapshot", "--endpoint", server.url],
      { env: { FRUGL_HOME_DIR: home.dir }, cwd: project.dir },
    );

    expect(exitCode).toBe(EXIT.OK);
    expect(readConfig()["org"]).toBe("acme"); // silently overwritten under --yes
  });

  it("FR-015: an upload failure does not undo the already-written .frugl.json", async () => {
    wireOrgMe(server, ACME);
    // No sessions are seeded under FRUGL_HOME_DIR, so the upload step fails with
    // "no sessions found" (exit 20). The config write happens BEFORE upload, so
    // it must survive the failure and the exit code reflects the upload error.
    const { exitCode } = await runCli(
      ["init", "--yes", "--org-name", "Acme", "--no-snapshot", "--endpoint", server.url],
      { env: { FRUGL_HOME_DIR: home.dir }, cwd: project.dir },
    );

    expect(existsSync(configPath())).toBe(true);
    expect(readConfig()["org"]).toBe("acme");
    expect(exitCode).toBe(EXIT.NO_SESSIONS_FOUND);
  });
});
