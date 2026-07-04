import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { EXIT } from "../lib/exit-codes.js";
import { runCli } from "../e2e/helpers/spawn.js";
import { clearAuth, injectAuth, makeTestSession } from "../e2e/helpers/auth.js";
import { makeTempDir, writeTestSessions, type TempDir } from "../e2e/helpers/fixtures.js";
import { recordProfileIdentity, recordProfileOrg } from "../lib/config.js";

// `frugl config` is a read-only settings readout: endpoint, account (from the
// non-secret profile cache — NO keychain read, NO cloud call), resolved project
// config, providers, and the repos that have opted into Frugl via a `.frugl.json`.
// These spawn the real CLI and assert the --format json shape. FRUGL_STATE_DIR
// isolates the conf-backed profile cache per test (so it never touches real CLI
// state); FRUGL_HOME_DIR scopes session discovery.

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

  // FRUGL_STATE_DIR isolates the conf profile cache; FRUGL_HOME_DIR scopes the
  // session/provider scan. Both point at the per-test temp home.
  function env(): Record<string, string> {
    return { FRUGL_STATE_DIR: home.dir, FRUGL_HOME_DIR: home.dir };
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

  it("shows the cached identity + org from the profile cache (no keychain/cloud)", async () => {
    // Seed the profile cache the way login/whoami would, then read it back.
    recordProfileIdentity(
      { endpoint: ENDPOINT, email: "cached@frugl.example", userId: "u-123" },
      { cwd: home.dir },
    );
    recordProfileOrg(ENDPOINT, { slug: "acme", name: "Acme", role: "owner" }, { cwd: home.dir });

    const { exitCode, stdout } = await runCli(
      ["config", "--no-repos", "--format", "json", "--endpoint", ENDPOINT],
      { env: env(), cwd: project.dir },
    );

    expect(exitCode).toBe(EXIT.OK);
    const cfg = parse(stdout);
    expect(cfg.account.loggedIn).toBe(true);
    expect(cfg.account.cached).toBe(true);
    expect(cfg.account.email).toBe("cached@frugl.example");
    expect(cfg.account.userId).toBe("u-123");
    expect(cfg.account.org).toEqual({ slug: "acme", name: "Acme", role: "owner" });
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

  it("merges subdirectories governed by the same .frugl.json into one repo row", async () => {
    // A monorepo root with .frugl.json, plus session history for two of its
    // subdirectories (as if Claude had been run from apps/web and packages/foo).
    // These share one governing config and must collapse into a single row with
    // a summed session count, not appear as separate repos.
    const repoDir = `/tmp/frugl_cfg_merge_${process.pid}/myrepo`;
    const subA = `${repoDir}/apps/web`;
    const subB = `${repoDir}/packages/foo`;
    mkdirSync(repoDir, { recursive: true });
    writeFileSync(path.join(repoDir, ".frugl.json"), `${JSON.stringify({ version: 1 })}\n`, "utf8");
    try {
      await writeTestSessions(home.dir, 2, subA.replace(/\//g, "-"));
      await writeTestSessions(home.dir, 3, subB.replace(/\//g, "-"));

      const { exitCode, stdout } = await runCli(
        ["config", "--format", "json", "--endpoint", ENDPOINT],
        { env: env(), cwd: project.dir },
      );

      expect(exitCode).toBe(EXIT.OK);
      const cfg = parse(stdout);
      expect(cfg.repos).not.toBeNull();
      expect(cfg.repos!.map((r) => r.path)).toEqual([repoDir]);
      expect(cfg.repos![0]!.sessions).toBe(5);
    } finally {
      rmSync(`/tmp/frugl_cfg_merge_${process.pid}`, { recursive: true, force: true });
    }
  });

  it("keeps sibling repos separate when one's name is a hyphenated prefix of the other", async () => {
    // Regression: decodeProjectPath can't tell a real "-" in a path segment
    // apart from an encoded "/", so a naive decode of "myrepo-cli" splits it
    // into "myrepo/cli" — which would wrongly resolve to the sibling
    // "myrepo" repo's .frugl.json and merge the two repos into one row.
    const base = `/tmp/frugl_cfg_prefix_${process.pid}`;
    const repoDir = `${base}/myrepo`;
    const cliDir = `${base}/myrepo-cli`;
    mkdirSync(repoDir, { recursive: true });
    mkdirSync(cliDir, { recursive: true });
    writeFileSync(path.join(repoDir, ".frugl.json"), `${JSON.stringify({ version: 1 })}\n`, "utf8");
    writeFileSync(path.join(cliDir, ".frugl.json"), `${JSON.stringify({ version: 1 })}\n`, "utf8");
    try {
      await writeTestSessions(home.dir, 2, repoDir.replace(/\//g, "-"));
      await writeTestSessions(home.dir, 3, cliDir.replace(/\//g, "-"));

      const { exitCode, stdout } = await runCli(
        ["config", "--format", "json", "--endpoint", ENDPOINT],
        { env: env(), cwd: project.dir },
      );

      expect(exitCode).toBe(EXIT.OK);
      const cfg = parse(stdout);
      expect(cfg.repos).not.toBeNull();
      const byPath = new Map(cfg.repos!.map((r) => [r.path, r.sessions]));
      expect(byPath.get(repoDir)).toBe(2);
      expect(byPath.get(cliDir)).toBe(3);
    } finally {
      rmSync(base, { recursive: true, force: true });
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

  it("supports the minimal (agent/CI) format: compact key=value lines, no decoration", async () => {
    const { exitCode, stdout } = await runCli(
      ["config", "--no-repos", "--format", "minimal", "--endpoint", ENDPOINT],
      { env: env(), cwd: project.dir },
    );

    expect(exitCode).toBe(EXIT.OK);
    // Plain, decoration-free text: no ANSI color escapes, no headings/blank
    // lines -- one grep-able `key=value` fact per line for agents/CI.
    expect(stdout).not.toContain("[");
    expect(stdout).not.toContain("\n\n");
    expect(stdout).toContain("endpoint.url=");
    expect(stdout).toContain("account.loggedIn=false");
    expect(stdout).toContain("upload.minCost=$10.00 source=default");
    expect(stdout).toContain("repos.count=skipped");
  });
});
