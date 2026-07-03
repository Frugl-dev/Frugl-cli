import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { IncomingMessage, ServerResponse } from "node:http";
import { mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { EXIT } from "../lib/exit-codes.js";
import { MockServer } from "../e2e/helpers/mock-server.js";
import { runCli } from "../e2e/helpers/spawn.js";
import { clearAuth, injectAuth, makeTestSession } from "../e2e/helpers/auth.js";
import { makeTempDir, writeTestSessions, type TempDir } from "../e2e/helpers/fixtures.js";

// `frugl config` is a read-only settings readout: endpoint, account (from the
// non-secret profile cache — NO keychain read, NO cloud call), resolved project
// config, providers, and the repos that have opted into Frugl via a `.frugl.json`.
// These spawn the real CLI and assert the --format json shape. HOME is pointed
// at a temp dir so the `conf`-backed profile cache is isolated per test; provider
// discovery is scoped with FRUGL_HOME_DIR so the scan never touches the dev's
// real machine.

const ENDPOINT = "http://localhost:59999";

interface ConfigJson {
  command: string;
  ok: boolean;
  endpoint: { url: string; resolvedFrom: string };
  account: {
    loggedIn: boolean;
    cached?: boolean;
    email?: string;
    userId?: string;
    loggedInAt?: string;
    org?: { slug: string; name: string; role: string } | null;
    updatedAt?: string;
  };
  projectConfig: { path: string | null; org: string | null; pin: unknown };
  settings: Record<string, { value: unknown; source: "config" | "default" }>;
  providers: { all: string[]; detected: string[] | null; targeted: string[] | null };
  repos: Array<{ path: string; provider: string; sessions: number; configPath: string }> | null;
}

function parse(stdout: string): ConfigJson {
  const line = stdout.trim().split("\n").at(-1) ?? "";
  return JSON.parse(line) as ConfigJson;
}

describe("frugl config", { timeout: 30_000 }, () => {
  let home: TempDir;
  let project: TempDir;

  beforeEach(async () => {
    home = await makeTempDir();
    project = await makeTempDir();
  });

  afterEach(async () => {
    clearAuth(ENDPOINT);
    await home.cleanup();
    await project.cleanup();
  });

  // HOME isolates the conf-backed profile cache; FRUGL_HOME_DIR scopes session
  // discovery. Both point at the per-test temp home.
  function env(): Record<string, string> {
    return { HOME: home.dir, FRUGL_HOME_DIR: home.dir };
  }

  function writeConfig(body: Record<string, unknown>): void {
    writeFileSync(
      path.join(project.dir, ".frugl.json"),
      `${JSON.stringify(body, null, 2)}\n`,
      "utf8",
    );
  }

  it("logged out with no config: defaults, no account, scan skipped", async () => {
    const { exitCode, stdout } = await runCli(
      ["config", "--no-repos", "--format", "json", "--endpoint", ENDPOINT],
      { env: env(), cwd: project.dir },
    );

    expect(exitCode).toBe(EXIT.OK);
    const cfg = parse(stdout);
    expect(cfg.ok).toBe(true);
    expect(cfg.endpoint.url).toBe(ENDPOINT);
    expect(cfg.account.loggedIn).toBe(false);
    expect(cfg.projectConfig.path).toBeNull();
    expect(cfg.projectConfig.org).toBeNull();
    expect(cfg.settings["upload.minCost"]).toEqual({ value: 10, source: "default" });
    expect(cfg.settings["upload.concurrency"]).toEqual({ value: 4, source: "default" });
    expect(cfg.providers.detected).toBeNull();
    expect(cfg.repos).toBeNull();
  });

  it("does NOT read the keychain — an injected session alone shows logged-out", async () => {
    // A real keychain session exists, but `config` reads the profile cache (empty
    // here), never the keychain — so no password prompt and account is logged-out.
    injectAuth(makeTestSession(ENDPOINT));

    const { exitCode, stdout } = await runCli(
      ["config", "--no-repos", "--format", "json", "--endpoint", ENDPOINT],
      { env: env(), cwd: project.dir },
    );

    expect(exitCode).toBe(EXIT.OK);
    expect(parse(stdout).account.loggedIn).toBe(false);
  });

  it("shows the cached identity a prior login persisted (no keychain/cloud at read)", async () => {
    // A login writes the profile cache; a later `config` reads it back.
    const server = await new MockServer().start();
    server.on("GET", "/api/auth/whoami", (_req: IncomingMessage, res: ServerResponse) => {
      server.json(res, 200, { user_id: "u-123", primary_email: "cached@frugl.example" });
    });
    try {
      const login = await runCli(
        ["login", "--token", "tok-xyz", "--format", "json", "--endpoint", server.url],
        { env: env(), cwd: project.dir },
      );
      expect(login.exitCode).toBe(EXIT.OK);

      const { exitCode, stdout } = await runCli(
        ["config", "--no-repos", "--format", "json", "--endpoint", server.url],
        { env: env(), cwd: project.dir },
      );
      expect(exitCode).toBe(EXIT.OK);
      const cfg = parse(stdout);
      expect(cfg.account.loggedIn).toBe(true);
      expect(cfg.account.cached).toBe(true);
      expect(cfg.account.email).toBe("cached@frugl.example");
      expect(cfg.account.userId).toBe("u-123");
      // The token flow doesn't resolve an org, so it's absent (not an error).
      expect(cfg.account.org).toBeNull();
    } finally {
      clearAuth(server.url);
      await server.close();
    }
  });

  it("resolves .frugl.json values and labels them as config, not default", async () => {
    writeConfig({
      version: 1,
      org: "acme",
      upload: { minCost: 25, concurrency: 8, providers: ["cursor"] },
    });

    const { exitCode, stdout } = await runCli(
      ["config", "--no-repos", "--format", "json", "--endpoint", ENDPOINT],
      { env: env(), cwd: project.dir },
    );

    expect(exitCode).toBe(EXIT.OK);
    const cfg = parse(stdout);
    // The repo-pinned org (a project setting), not the live account org.
    expect(cfg.projectConfig.org).toBe("acme");
    // Canonicalize: on macOS the spawned cwd resolves /var → /private/var.
    expect(realpathSync(cfg.projectConfig.path!)).toBe(
      realpathSync(path.join(project.dir, ".frugl.json")),
    );
    expect(cfg.settings["upload.minCost"]).toEqual({ value: 25, source: "config" });
    expect(cfg.settings["upload.concurrency"]).toEqual({ value: 8, source: "config" });
    expect(cfg.settings["upload.auto"]).toEqual({ value: false, source: "default" });
  });

  it("detects providers and applies the config's provider filter to the targeted set", async () => {
    await writeTestSessions(home.dir, 2, "-Users-me-app");
    writeConfig({ version: 1, upload: { providers: ["claude"] } });

    const { exitCode, stdout } = await runCli(
      ["config", "--format", "json", "--endpoint", ENDPOINT],
      { env: env(), cwd: project.dir },
    );

    expect(exitCode).toBe(EXIT.OK);
    const cfg = parse(stdout);
    expect(cfg.providers.detected).toContain("claude");
    expect(cfg.providers.targeted).toEqual(["claude"]);
  });

  it("a provider filter that matches nothing targets no providers", async () => {
    await writeTestSessions(home.dir, 1, "-Users-me-app");
    writeConfig({ version: 1, upload: { providers: ["cursor"] } });

    const { exitCode, stdout } = await runCli(
      ["config", "--format", "json", "--endpoint", ENDPOINT],
      { env: env(), cwd: project.dir },
    );

    expect(exitCode).toBe(EXIT.OK);
    const cfg = parse(stdout);
    expect(cfg.providers.detected).toContain("claude");
    expect(cfg.providers.targeted).toEqual([]);
  });

  it("lists only repos that have a governing .frugl.json", async () => {
    // A repo whose real path has no dashes, so Claude's encode (/→-) round-trips
    // through the lossy decode (-→/) back to this exact directory.
    const repoDir = `/tmp/frugl_cfg_${process.pid}/myrepo`;
    mkdirSync(repoDir, { recursive: true });
    writeFileSync(path.join(repoDir, ".frugl.json"), `${JSON.stringify({ version: 1 })}\n`, "utf8");
    try {
      const encoded = repoDir.replace(/\//g, "-"); // "-tmp-frugl_cfg_<pid>-myrepo"
      await writeTestSessions(home.dir, 2, encoded);
      // A second repo WITHOUT a .frugl.json — must be filtered out.
      await writeTestSessions(home.dir, 1, "-tmp-frugl_cfg-noconfig-repo");

      const { exitCode, stdout } = await runCli(
        ["config", "--format", "json", "--endpoint", ENDPOINT],
        { env: env(), cwd: project.dir },
      );

      expect(exitCode).toBe(EXIT.OK);
      const cfg = parse(stdout);
      expect(cfg.repos).not.toBeNull();
      expect(cfg.repos!.map((r) => r.path)).toEqual([repoDir]);
      expect(cfg.repos![0]!.provider).toBe("claude");
      expect(cfg.repos![0]!.sessions).toBe(2);
      expect(realpathSync(cfg.repos![0]!.configPath)).toBe(
        realpathSync(path.join(repoDir, ".frugl.json")),
      );
    } finally {
      rmSync(`/tmp/frugl_cfg_${process.pid}`, { recursive: true, force: true });
    }
  });

  it("returns an empty repo list when no repo has a .frugl.json", async () => {
    await writeTestSessions(home.dir, 1, "-tmp-frugl_cfg-unconfigured");

    const { exitCode, stdout } = await runCli(
      ["config", "--format", "json", "--endpoint", ENDPOINT],
      { env: env(), cwd: project.dir },
    );

    expect(exitCode).toBe(EXIT.OK);
    const cfg = parse(stdout);
    // Empty (not null) — the cue the human output turns into a `frugl init` nudge.
    expect(cfg.repos).toEqual([]);
  });

  it("supports the minimal (agent/CI) format", async () => {
    const { exitCode, stdout } = await runCli(
      ["config", "--no-repos", "--format", "minimal", "--endpoint", ENDPOINT],
      { env: env(), cwd: project.dir },
    );

    expect(exitCode).toBe(EXIT.OK);
    // Plain, decoration-free text: no ANSI color escapes, still showing settings.
    expect(stdout).not.toContain("[");
    expect(stdout).toContain("Endpoint");
    expect(stdout).toContain("upload.minCost");
  });
});
