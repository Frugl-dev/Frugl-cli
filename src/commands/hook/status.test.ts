import { afterEach, beforeEach, describe, expect, it } from "vitest";
import path from "node:path";
import { makeTempDir, type TempDir } from "../../e2e/helpers/fixtures.js";
import { runCli } from "../../e2e/helpers/spawn.js";

// Drives `hook status` via the spawned CLI against a throwaway HOME (--global),
// asserting both the not-installed and installed states plus the JSON shape.

interface StatusJson {
  command: string;
  ok: boolean;
  installed: boolean;
  path: string;
  scope: string;
}

function settingsFile(home: string): string {
  return path.join(home, ".claude", "settings.json");
}

describe("frugl hook status", { timeout: 30_000 }, () => {
  let home: TempDir;

  beforeEach(async () => {
    home = await makeTempDir();
  });

  afterEach(async () => {
    await home.cleanup();
  });

  it("reports not-installed for a fresh HOME (json shape)", async () => {
    const { exitCode, stdout } = await runCli(["hook", "status", "--global", "--format", "json"], {
      env: { HOME: home.dir },
    });
    expect(exitCode).toBe(0);

    const json = JSON.parse(stdout.trim()) as StatusJson;
    expect(json.command).toBe("hook status");
    expect(json.ok).toBe(true);
    expect(json.installed).toBe(false);
    expect(json.scope).toBe("global");
    expect(json.path).toBe(settingsFile(home.dir));
  });

  it("reports not-installed in human output for a fresh HOME", async () => {
    const { exitCode, stdout } = await runCli(["hook", "status", "--global"], {
      env: { HOME: home.dir },
    });
    expect(exitCode).toBe(0);
    expect(stdout).toMatch(/No Frugl hook installed/);
  });

  it("reports installed after install (json shape)", async () => {
    const env = { HOME: home.dir, FRUGL_TOKEN: "tok_test" };
    await runCli(["hook", "install", "--global"], { env });

    const { exitCode, stdout } = await runCli(["hook", "status", "--global", "--format", "json"], {
      env,
    });
    expect(exitCode).toBe(0);
    const json = JSON.parse(stdout.trim()) as StatusJson;
    expect(json.installed).toBe(true);
    expect(json.path).toBe(settingsFile(home.dir));
  });
});
