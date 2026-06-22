import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { makeTempDir, type TempDir } from "../../e2e/helpers/fixtures.js";
import { runCli } from "../../e2e/helpers/spawn.js";

// These tests drive the `hook install` command end-to-end via the spawned CLI,
// using --global so the settings file lands in a throwaway HOME (homedir()
// honours $HOME) and no real Claude settings are touched.

interface InstallJson {
  command: string;
  ok: boolean;
  path: string;
  hookCommand: string;
  scope: string;
  tokenConfigured: boolean;
}

function settingsFile(home: string): string {
  return path.join(home, ".claude", "settings.json");
}

async function readSettings(home: string): Promise<{
  hooks?: { SessionEnd?: Array<{ hooks: Array<{ type: string; command: string }> }> };
}> {
  return JSON.parse(await readFile(settingsFile(home), "utf8")) as never;
}

describe("frugl hook install", { timeout: 30_000 }, () => {
  let home: TempDir;

  beforeEach(async () => {
    home = await makeTempDir();
  });

  afterEach(async () => {
    await home.cleanup();
  });

  it("creates the settings file with a SessionEnd frugl-upload hook and exits 0", async () => {
    const { exitCode } = await runCli(["hook", "install", "--global"], {
      env: { HOME: home.dir, FRUGL_TOKEN: "tok_test" },
    });
    expect(exitCode).toBe(0);

    const groups = (await readSettings(home.dir)).hooks?.SessionEnd ?? [];
    expect(groups).toHaveLength(1);
    expect(groups[0]!.hooks[0]).toMatchObject({ type: "command" });
    expect(groups[0]!.hooks[0]!.command).toMatch(/frugl upload/);
  });

  it("emits --format json describing the install", async () => {
    const { exitCode, stdout } = await runCli(["hook", "install", "--global", "--format", "json"], {
      env: { HOME: home.dir, FRUGL_TOKEN: "tok_test" },
    });
    expect(exitCode).toBe(0);

    const json = JSON.parse(stdout.trim()) as InstallJson;
    expect(json.command).toBe("hook install");
    expect(json.ok).toBe(true);
    expect(json.scope).toBe("global");
    expect(json.path).toBe(settingsFile(home.dir));
    expect(json.hookCommand).toMatch(/frugl upload/);
    expect(json.tokenConfigured).toBe(true);
  });

  it("reports tokenConfigured:false when no token is available", async () => {
    const { exitCode, stdout } = await runCli(["hook", "install", "--global", "--format", "json"], {
      // Strip any inherited FRUGL_TOKEN so the warning branch is exercised.
      env: { HOME: home.dir, FRUGL_TOKEN: undefined },
    });
    expect(exitCode).toBe(0);
    const json = JSON.parse(stdout.trim()) as InstallJson;
    expect(json.tokenConfigured).toBe(false);
  });

  it("is idempotent — re-installing leaves a single managed entry", async () => {
    const env = { HOME: home.dir, FRUGL_TOKEN: "tok_test" };
    await runCli(["hook", "install", "--global"], { env });
    const { exitCode } = await runCli(["hook", "install", "--global"], { env });
    expect(exitCode).toBe(0);

    const groups = (await readSettings(home.dir)).hooks?.SessionEnd ?? [];
    expect(groups).toHaveLength(1);
  });
});
