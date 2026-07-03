import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { makeTempDir, type TempDir } from "../../e2e/helpers/fixtures.js";
import { runCli } from "../../e2e/helpers/spawn.js";

// These tests drive the `hook install` command end-to-end via the spawned CLI,
// using --global so config files land in a throwaway HOME (homedir() honours
// $HOME) and no real tool settings are touched. Detection reads the same HOME,
// so tests opt providers in by creating their config dirs.

interface ProviderOutcome {
  id: string;
  displayName: string;
  status: "installed" | "skipped" | "conflict";
  path: string;
  reason?: string;
}

interface InstallJson {
  command: string;
  ok: boolean;
  scope: string;
  hookCommand: string;
  tokenConfigured: boolean;
  providers: ProviderOutcome[];
}

function claudeSettingsFile(home: string): string {
  return path.join(home, ".claude", "settings.json");
}

async function readClaudeSettings(home: string): Promise<{
  hooks?: { SessionEnd?: Array<{ hooks: Array<{ type: string; command: string }> }> };
}> {
  return JSON.parse(await readFile(claudeSettingsFile(home), "utf8")) as never;
}

function outcome(json: InstallJson, id: string): ProviderOutcome | undefined {
  return json.providers.find((p) => p.id === id);
}

describe("frugl hook install", { timeout: 30_000 }, () => {
  let home: TempDir;

  beforeEach(async () => {
    home = await makeTempDir();
  });

  afterEach(async () => {
    await home.cleanup();
  });

  it("installs hooks for detected tools only, skipping undetected ones", async () => {
    await mkdir(path.join(home.dir, ".claude"), { recursive: true });
    await mkdir(path.join(home.dir, ".codex"), { recursive: true });

    const { exitCode, stdout } = await runCli(["hook", "install", "--global", "--format", "json"], {
      env: { HOME: home.dir, FRUGL_TOKEN: "tok_test" },
    });
    expect(exitCode).toBe(0);

    const json = JSON.parse(stdout.trim()) as InstallJson;
    expect(json.command).toBe("hook install");
    expect(json.ok).toBe(true);
    expect(json.scope).toBe("global");
    expect(json.hookCommand).toBe("frugl hook run");
    expect(json.tokenConfigured).toBe(true);
    expect(outcome(json, "claude")?.status).toBe("installed");
    expect(outcome(json, "codex")?.status).toBe("installed");
    expect(outcome(json, "gemini")).toMatchObject({
      status: "skipped",
      reason: "not detected on this machine",
    });
    expect(outcome(json, "cursor")?.status).toBe("skipped");

    const groups = (await readClaudeSettings(home.dir)).hooks?.SessionEnd ?? [];
    expect(groups).toHaveLength(1);
    expect(groups[0]!.hooks[0]).toMatchObject({ type: "command", command: "frugl hook run" });

    const codexConfig = await readFile(path.join(home.dir, ".codex", "config.toml"), "utf8");
    expect(codexConfig).toContain('notify = ["frugl", "hook", "run"]');
  });

  it("--providers installs a named tool even when undetected", async () => {
    const { exitCode, stdout } = await runCli(
      ["hook", "install", "--global", "--providers", "gemini", "--format", "json"],
      { env: { HOME: home.dir, FRUGL_TOKEN: "tok_test" } },
    );
    expect(exitCode).toBe(0);
    const json = JSON.parse(stdout.trim()) as InstallJson;
    expect(json.providers).toHaveLength(1);
    expect(outcome(json, "gemini")?.status).toBe("installed");

    const settings = JSON.parse(
      await readFile(path.join(home.dir, ".gemini", "settings.json"), "utf8"),
    ) as { hooks: { SessionEnd: Array<{ hooks: Array<{ command: string }> }> } };
    expect(settings.hooks.SessionEnd[0]!.hooks[0]!.command).toBe("frugl hook run");
  });

  it("skips codex at project scope (config is machine-global)", async () => {
    const project = await makeTempDir();
    const { exitCode, stdout } = await runCli(
      ["hook", "install", "--providers", "codex", "--format", "json"],
      { env: { HOME: home.dir, FRUGL_TOKEN: "tok_test" }, cwd: project.dir },
    );
    expect(exitCode).toBe(0);
    const json = JSON.parse(stdout.trim()) as InstallJson;
    expect(outcome(json, "codex")).toMatchObject({ status: "skipped" });
    expect(outcome(json, "codex")?.reason).toMatch(/--global/);
    await project.cleanup();
  });

  it("reports tokenConfigured:false when no token is available", async () => {
    const { exitCode, stdout } = await runCli(
      ["hook", "install", "--global", "--providers", "claude", "--format", "json"],
      {
        // Strip any inherited credentials so the dormant-hooks branch is exercised.
        env: { HOME: home.dir, FRUGL_TOKEN: undefined, FRUGL_ENDPOINT: undefined },
      },
    );
    expect(exitCode).toBe(0);
    const json = JSON.parse(stdout.trim()) as InstallJson;
    expect(json.tokenConfigured).toBe(false);
  });

  it("is idempotent — re-installing leaves a single managed entry", async () => {
    await mkdir(path.join(home.dir, ".claude"), { recursive: true });
    const env = { HOME: home.dir, FRUGL_TOKEN: "tok_test" };
    await runCli(["hook", "install", "--global"], { env });
    const { exitCode } = await runCli(["hook", "install", "--global"], { env });
    expect(exitCode).toBe(0);

    const groups = (await readClaudeSettings(home.dir)).hooks?.SessionEnd ?? [];
    expect(groups).toHaveLength(1);
  });
});
