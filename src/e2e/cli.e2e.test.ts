import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import path from "node:path";
import { mkdir } from "node:fs/promises";
import { createServer, type Server as HttpServer } from "node:http";
import type { AddressInfo } from "node:net";
import { EXIT } from "../lib/exit-codes.js";
import { MockServer } from "./helpers/mock-server.js";
import { runCli } from "./helpers/spawn.js";
import { injectAuth, clearAuth, makeTestSession } from "./helpers/auth.js";
import { makeTempDir, writeTestSessions, type TempDir } from "./helpers/fixtures.js";

// All spawned CLI processes run against tsx bin/dev.js so the TypeScript
// source is executed directly without a build step.

describe("frugl CLI – e2e spawn tests", { timeout: 30_000 }, () => {
  // ---------------------------------------------------------------------------
  // Usage errors – no auth, no server needed
  // ---------------------------------------------------------------------------
  describe("usage errors", () => {
    it("--inspect without --dry-run → exit 2", async () => {
      const { exitCode, stderr } = await runCli([
        "upload",
        "--inspect",
        "./nowhere",
        "--endpoint",
        "http://127.0.0.1:1",
      ]);
      expect(exitCode).toBe(EXIT.USAGE);
      expect(stderr).toMatch(/inspect.*dry-run/i);
    });

    it("--limit 0 → exit 2", async () => {
      const { exitCode, stderr } = await runCli([
        "upload",
        "--limit",
        "0",
        "--endpoint",
        "http://127.0.0.1:1",
      ]);
      expect(exitCode).toBe(EXIT.USAGE);
      expect(stderr).toMatch(/limit.*positive/i);
    });
  });

  // ---------------------------------------------------------------------------
  // Auth errors – no session in keychain
  // ---------------------------------------------------------------------------
  describe("auth errors", () => {
    const endpoint = "http://127.0.0.1:59990";

    it("whoami with no stored session → exit 10", async () => {
      clearAuth(endpoint);
      const { exitCode, stderr } = await runCli(["whoami", "--endpoint", endpoint]);
      expect(exitCode).toBe(EXIT.AUTH_FAILURE);
      expect(stderr).toMatch(/not logged in/i);
    });

    it("upload with no stored session → exit 10", async () => {
      clearAuth(endpoint);
      const { exitCode, stderr } = await runCli(["upload", "--yes", "--endpoint", endpoint]);
      expect(exitCode).toBe(EXIT.AUTH_FAILURE);
      expect(stderr).toMatch(/not logged in/i);
    });
  });

  // ---------------------------------------------------------------------------
  // No sessions found
  // ---------------------------------------------------------------------------
  describe("no sessions found", () => {
    let tmp: TempDir;
    // Use a port that almost certainly has nothing listening so we never make
    // a real network call (discovery exits before any HTTP).
    const endpoint = "http://127.0.0.1:59991";

    beforeAll(async () => {
      tmp = await makeTempDir();
      // homeDir exists but has no .claude/projects/*.jsonl files
      injectAuth(makeTestSession(endpoint));
    });

    afterAll(async () => {
      clearAuth(endpoint);
      await tmp.cleanup();
    });

    it("→ exit 20 and names the searched directory", async () => {
      const { exitCode, stderr } = await runCli(["upload", "--yes", "--endpoint", endpoint], {
        env: { FRUGL_HOME_DIR: tmp.dir },
      });
      expect(exitCode).toBe(EXIT.NO_SESSIONS_FOUND);
      expect(stderr).toMatch(/no sessions/i);
    });
  });

  // ---------------------------------------------------------------------------
  // Endpoint unreachable
  // ---------------------------------------------------------------------------
  describe("endpoint unreachable", () => {
    // Port 1 is reserved and almost universally unreachable.
    const endpoint = "http://127.0.0.1:1";
    let tmp: TempDir;

    beforeAll(async () => {
      tmp = await makeTempDir();
      await writeTestSessions(tmp.dir, 1);
      injectAuth(makeTestSession(endpoint));
    });

    afterAll(async () => {
      clearAuth(endpoint);
      await tmp.cleanup();
    });

    it("→ exit 41", async () => {
      const { exitCode, stderr } = await runCli(["upload", "--yes", "--endpoint", endpoint], {
        env: { FRUGL_HOME_DIR: tmp.dir },
      });
      expect(exitCode).toBe(EXIT.ENDPOINT_UNREACHABLE);
      expect(stderr).toMatch(/unreachable/i);
    });
  });

  // ---------------------------------------------------------------------------
  // Dry-run inspection
  // ---------------------------------------------------------------------------
  describe("dry-run inspection", () => {
    // No actual server needed – dry-run exits before any network call.
    const endpoint = "http://127.0.0.1:59992";
    let tmp: TempDir;

    beforeAll(async () => {
      tmp = await makeTempDir();
      await writeTestSessions(tmp.dir, 2);
      injectAuth(makeTestSession(endpoint));
    });

    afterAll(async () => {
      clearAuth(endpoint);
      await tmp.cleanup();
    });

    it("writes inspect dir and exits 0 with no network traffic", async () => {
      const inspectDir = path.join(tmp.dir, "inspect-out");
      const { exitCode, stdout } = await runCli(
        ["upload", "--dry-run", "--json", "--inspect", inspectDir, "--endpoint", endpoint],
        { env: { FRUGL_HOME_DIR: tmp.dir } },
      );
      expect(exitCode).toBe(EXIT.OK);
      // Final JSON on stdout has dryRun:true
      const result = JSON.parse(stdout.trim().split("\n").at(-1)!);
      expect(result.dryRun).toBe(true);
      expect(result.ok).toBe(true);
      // Redaction summary written to inspect dir
      const { existsSync } = await import("node:fs");
      expect(existsSync(path.join(inspectDir, "redaction-summary.json"))).toBe(true);
    });

    it("→ exit 60 when inspect dir already exists without --force", async () => {
      const existingDir = path.join(tmp.dir, "already-exists");
      await mkdir(existingDir);
      const { exitCode, stderr } = await runCli(
        ["upload", "--dry-run", "--inspect", existingDir, "--endpoint", endpoint],
        { env: { FRUGL_HOME_DIR: tmp.dir } },
      );
      expect(exitCode).toBe(EXIT.INSPECT_DIR_EXISTS);
      expect(stderr).toMatch(/already exists/i);
    });

    it("--force overwrites an existing inspect dir", async () => {
      const existingDir = path.join(tmp.dir, "force-overwrite");
      await mkdir(existingDir);
      const { exitCode } = await runCli(
        ["upload", "--dry-run", "--inspect", existingDir, "--force", "--endpoint", endpoint],
        { env: { FRUGL_HOME_DIR: tmp.dir } },
      );
      expect(exitCode).toBe(EXIT.OK);
    });
  });

  // ---------------------------------------------------------------------------
  // Happy path upload
  // ---------------------------------------------------------------------------
  describe("happy path upload", () => {
    let server: MockServer;
    let tmp: TempDir;
    let manifestId: string;

    beforeAll(async () => {
      server = await new MockServer().start();
      manifestId = MockServer.wireHappyPath(server);
      tmp = await makeTempDir();
      await writeTestSessions(tmp.dir, 3);
      injectAuth(makeTestSession(server.url));
    });

    afterAll(async () => {
      clearAuth(server.url);
      await tmp.cleanup();
      await server.close();
    });

    it("exits 0 and emits manifest ID + dashboard URL on stdout", async () => {
      const { exitCode, stdout } = await runCli(
        ["upload", "--yes", "--json", "--endpoint", server.url],
        {
          env: { FRUGL_HOME_DIR: tmp.dir },
        },
      );
      expect(exitCode).toBe(EXIT.OK);
      const result = JSON.parse(stdout.trim().split("\n").at(-1)!);
      expect(result.ok).toBe(true);
      expect(result.manifestId).toBe(manifestId);
      expect(result.dashboardUrl).toContain(manifestId);
      expect(result.actualSessionCount).toBe(3);
    });
  });

  // ---------------------------------------------------------------------------
  // Incremental upload – second run is a noop
  // ---------------------------------------------------------------------------
  describe("incremental upload", () => {
    let server: MockServer;
    let tmp: TempDir;

    beforeAll(async () => {
      server = await new MockServer().start();
      MockServer.wireHappyPath(server);
      tmp = await makeTempDir();
      await writeTestSessions(tmp.dir, 2);
      injectAuth(makeTestSession(server.url));
    });

    afterAll(async () => {
      clearAuth(server.url);
      await tmp.cleanup();
      await server.close();
    });

    it("first run uploads; second run reports no new or updated sessions", async () => {
      const env = { FRUGL_HOME_DIR: tmp.dir };
      const first = await runCli(["upload", "--yes", "--json", "--endpoint", server.url], {
        env,
      });
      expect(first.exitCode).toBe(EXIT.OK);
      const firstResult = JSON.parse(first.stdout.trim().split("\n").at(-1)!);
      expect(firstResult.actualSessionCount).toBe(2);

      const second = await runCli(
        ["upload", "--sessions", "--yes", "--json", "--endpoint", server.url],
        {
          env,
        },
      );
      expect(second.exitCode).toBe(EXIT.OK);
      const secondResult = JSON.parse(second.stdout.trim().split("\n").at(-1)!);
      expect(secondResult.noop).toBe(true);
      expect(secondResult.classification.unchanged).toBe(2);
    });
  });

  // ---------------------------------------------------------------------------
  // --limit flag
  // ---------------------------------------------------------------------------
  describe("--limit flag", () => {
    let server: MockServer;
    let tmp: TempDir;

    beforeAll(async () => {
      server = await new MockServer().start();
      MockServer.wireHappyPath(server);
      tmp = await makeTempDir();
      await writeTestSessions(tmp.dir, 5);
      injectAuth(makeTestSession(server.url));
    });

    afterAll(async () => {
      clearAuth(server.url);
      await tmp.cleanup();
      await server.close();
    });

    it("uploads only N sessions when --limit N is passed", async () => {
      const { exitCode, stdout } = await runCli(
        ["upload", "--yes", "--limit", "2", "--json", "--endpoint", server.url],
        { env: { FRUGL_HOME_DIR: tmp.dir } },
      );
      expect(exitCode).toBe(EXIT.OK);
      const result = JSON.parse(stdout.trim().split("\n").at(-1)!);
      expect(result.actualSessionCount).toBe(2);
      expect(result.limited).toMatchObject({ active: true });
    });
  });

  // ---------------------------------------------------------------------------
  // Version gate
  // ---------------------------------------------------------------------------
  describe("version gate", () => {
    let server: MockServer;
    let tmp: TempDir;

    beforeAll(async () => {
      server = await new MockServer().start();
      // Every request returns 426 with minSupportedCliVersion body
      server.on("POST", "/api/uploads/manifest", (_req, res) => {
        server.json(res, 426, { minSupportedCliVersion: "99.0.0" });
      });
      tmp = await makeTempDir();
      await writeTestSessions(tmp.dir, 1);
      injectAuth(makeTestSession(server.url));
    });

    afterAll(async () => {
      clearAuth(server.url);
      await tmp.cleanup();
      await server.close();
    });

    it("→ exit 50 and upgrade message names required version", async () => {
      const { exitCode, stderr } = await runCli(["upload", "--yes", "--endpoint", server.url], {
        env: { FRUGL_HOME_DIR: tmp.dir },
      });
      expect(exitCode).toBe(EXIT.VERSION_GATE_FAILURE);
      expect(stderr).toMatch(/99\.0\.0/);
    });
  });

  // ---------------------------------------------------------------------------
  // --json output mode
  // ---------------------------------------------------------------------------
  describe("--json output mode", () => {
    describe("whoami --json", () => {
      const endpoint = "http://127.0.0.1:59993";

      beforeEach(() => {
        injectAuth(makeTestSession(endpoint));
      });

      afterEach(() => {
        clearAuth(endpoint);
      });

      it("emits a valid JSON object on stdout with ok:true", async () => {
        const { exitCode, stdout } = await runCli(["whoami", "--json", "--endpoint", endpoint]);
        expect(exitCode).toBe(EXIT.OK);
        const result = JSON.parse(stdout.trim());
        expect(result.ok).toBe(true);
        expect(result.email).toBe("tester@frugl-e2e.example");
        expect(result.command).toBe("whoami");
      });

      it("emits ok:false when not logged in", async () => {
        clearAuth(endpoint);
        const { exitCode, stdout } = await runCli(["whoami", "--json", "--endpoint", endpoint]);
        expect(exitCode).toBe(EXIT.AUTH_FAILURE);
        const result = JSON.parse(stdout.trim());
        expect(result.ok).toBe(false);
        expect(result.reason).toBe("not-logged-in");
      });
    });

    describe("upload --dry-run --json", () => {
      const endpoint = "http://127.0.0.1:59994";
      let tmp: TempDir;

      beforeAll(async () => {
        tmp = await makeTempDir();
        await writeTestSessions(tmp.dir, 1);
        injectAuth(makeTestSession(endpoint));
      });

      afterAll(async () => {
        clearAuth(endpoint);
        await tmp.cleanup();
      });

      it("emits JSON with dryRun:true as the last stdout line", async () => {
        const { exitCode, stdout } = await runCli(
          ["upload", "--dry-run", "--json", "--endpoint", endpoint],
          { env: { FRUGL_HOME_DIR: tmp.dir } },
        );
        expect(exitCode).toBe(EXIT.OK);
        // All stdout lines must be valid JSON (NDJSON mode)
        const lines = stdout.trim().split("\n").filter(Boolean);
        for (const line of lines) {
          expect(() => JSON.parse(line)).not.toThrow();
        }
        const last = JSON.parse(lines.at(-1)!);
        expect(last.dryRun).toBe(true);
        expect(last.ok).toBe(true);
      });
    });
  });

  // ---------------------------------------------------------------------------
  // Dry-run zero outbound network (FR-018 / SC-004)
  // ---------------------------------------------------------------------------
  describe("dry-run zero outbound network (FR-018)", () => {
    let httpServer: HttpServer;
    let requestCount: number;
    let recordingEndpoint: string;
    let tmp: TempDir;

    beforeAll(async () => {
      requestCount = 0;
      await new Promise<void>((resolve) => {
        httpServer = createServer((_req, res) => {
          requestCount++;
          res.writeHead(200, { "Content-Type": "application/json" }).end("{}");
        });
        httpServer.listen(0, "127.0.0.1", () => {
          const { port } = httpServer.address() as AddressInfo;
          recordingEndpoint = `http://127.0.0.1:${port}`;
          resolve();
        });
      });
      tmp = await makeTempDir();
      await writeTestSessions(tmp.dir, 3);
      injectAuth(makeTestSession(recordingEndpoint));
    });

    afterAll(async () => {
      clearAuth(recordingEndpoint);
      await tmp.cleanup();
      await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    });

    it("emits zero HTTP requests to the endpoint during --dry-run", async () => {
      requestCount = 0;
      const { exitCode, stdout } = await runCli(
        ["upload", "--dry-run", "--json", "--endpoint", recordingEndpoint],
        { env: { FRUGL_HOME_DIR: tmp.dir } },
      );
      expect(exitCode).toBe(EXIT.OK);
      const result = JSON.parse(stdout.trim().split("\n").at(-1)!);
      expect(result.dryRun).toBe(true);
      expect(requestCount).toBe(0);
    });
  });

  // ---------------------------------------------------------------------------
  // SC-004 ordered end-to-end sequence (mock server)
  // ---------------------------------------------------------------------------
  describe("SC-004 ordered end-to-end sequence", { timeout: 30_000 }, () => {
    let server: MockServer;
    let tmp: TempDir;

    beforeAll(async () => {
      server = await new MockServer().start();
      MockServer.wireHappyPath(server);
      tmp = await makeTempDir();
      await writeTestSessions(tmp.dir, 3);
      injectAuth(makeTestSession(server.url));
    });

    afterAll(async () => {
      clearAuth(server.url);
      await tmp.cleanup();
      await server.close();
    });

    const env = () => ({ FRUGL_HOME_DIR: tmp.dir });

    it("step 1: whoami prints stored identity", async () => {
      const { exitCode, stdout } = await runCli(["whoami", "--endpoint", server.url]);
      expect(exitCode).toBe(EXIT.OK);
      expect(stdout).toContain("tester@frugl-e2e.example");
    });

    it("step 2: dry-run + inspect writes dir, exit 0, no network", async () => {
      const inspectDir = path.join(tmp.dir, "sc004-inspect");
      const { exitCode, stdout } = await runCli(
        ["upload", "--dry-run", "--json", "--inspect", inspectDir, "--endpoint", server.url],
        { env: env() },
      );
      expect(exitCode).toBe(EXIT.OK);
      const result = JSON.parse(stdout.trim().split("\n").at(-1)!);
      expect(result.dryRun).toBe(true);
      const { existsSync } = await import("node:fs");
      expect(existsSync(path.join(inspectDir, "redaction-summary.json"))).toBe(true);
    });

    it("step 3: upload --yes uploads all 3 sessions", async () => {
      const { exitCode, stdout } = await runCli(
        ["upload", "--yes", "--json", "--endpoint", server.url],
        {
          env: env(),
        },
      );
      expect(exitCode).toBe(EXIT.OK);
      const result = JSON.parse(stdout.trim().split("\n").at(-1)!);
      expect(result.ok).toBe(true);
      expect(result.actualSessionCount).toBe(3);
    });

    it("step 4: second upload --yes is a noop", async () => {
      const { exitCode, stdout } = await runCli(
        ["upload", "--sessions", "--yes", "--json", "--endpoint", server.url],
        {
          env: env(),
        },
      );
      expect(exitCode).toBe(EXIT.OK);
      const result = JSON.parse(stdout.trim().split("\n").at(-1)!);
      expect(result.noop).toBe(true);
      expect(result.classification.unchanged).toBe(3);
    });

    it("step 5: --limit 1 uploads exactly 1 new session", async () => {
      await writeTestSessions(tmp.dir, 1, "sc004-new-project");
      const { exitCode, stdout } = await runCli(
        ["upload", "--limit", "1", "--yes", "--json", "--endpoint", server.url],
        { env: env() },
      );
      expect(exitCode).toBe(EXIT.OK);
      const result = JSON.parse(stdout.trim().split("\n").at(-1)!);
      expect(result.actualSessionCount).toBe(1);
      expect(result.limited).toMatchObject({ active: true });
    });

    it("step 6: logout then whoami exits AUTH_FAILURE (10)", async () => {
      const logout = await runCli(["logout", "--endpoint", server.url]);
      expect(logout.exitCode).toBe(EXIT.OK);

      const whoami = await runCli(["whoami", "--endpoint", server.url]);
      expect(whoami.exitCode).toBe(EXIT.AUTH_FAILURE);
    });
  });

  // ---------------------------------------------------------------------------
  // SC-003 upload timing: ≤ 200 sessions in ≤ 60 s (mock server baseline)
  // ---------------------------------------------------------------------------
  describe("SC-003 upload timing (200 sessions ≤ 60 s)", { timeout: 90_000 }, () => {
    let server: MockServer;
    let tmp: TempDir;

    beforeAll(async () => {
      server = await new MockServer().start();
      MockServer.wireHappyPath(server);
      tmp = await makeTempDir();
      // Write 200 synthetic sessions across 4 project dirs to simulate real usage
      await Promise.all(
        Array.from({ length: 4 }, (_, proj) => writeTestSessions(tmp.dir, 50, `project-${proj}`)),
      );
      injectAuth(makeTestSession(server.url));
    });

    afterAll(async () => {
      clearAuth(server.url);
      await tmp.cleanup();
      await server.close();
    });

    it("uploads 200 sessions in ≤ 60 s (SC-003)", async () => {
      const start = performance.now();
      const { exitCode, stdout } = await runCli(
        ["upload", "--yes", "--json", "--endpoint", server.url],
        {
          env: { FRUGL_HOME_DIR: tmp.dir },
          timeoutMs: 70_000,
        },
      );
      const elapsedMs = performance.now() - start;
      expect(exitCode).toBe(EXIT.OK);
      const result = JSON.parse(stdout.trim().split("\n").at(-1)!);
      expect(result.ok).toBe(true);
      expect(result.actualSessionCount).toBe(200);
      expect(elapsedMs).toBeLessThan(60_000);
    });
  });
});
