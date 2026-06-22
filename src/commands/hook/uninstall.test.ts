import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { makeTempDir, type TempDir } from "../../e2e/helpers/fixtures.js";
import { runCli } from "../../e2e/helpers/spawn.js";

// Drives `hook uninstall` via the spawned CLI against a throwaway HOME
// (--global), covering the no-op case, removal, the JSON shape, and a full
// install -> status -> uninstall round trip.

interface UninstallJson {
  command: string;
  ok: boolean;
  path: string;
  removed: boolean;
  scope: string;
}

interface StatusJson {
  installed: boolean;
}

function settingsFile(home: string): string {
  return path.join(home, ".claude", "settings.json");
}

async function readSessionEndGroups(
  home: string,
): Promise<Array<{ hooks: Array<{ command: string }> }> | undefined> {
  const settings = JSON.parse(await readFile(settingsFile(home), "utf8")) as {
    hooks?: { SessionEnd?: Array<{ hooks: Array<{ command: string }> }> };
  };
  return settings.hooks?.SessionEnd;
}

describe("frugl hook uninstall", { timeout: 30_000 }, () => {
  let home: TempDir;

  beforeEach(async () => {
    home = await makeTempDir();
  });

  afterEach(async () => {
    await home.cleanup();
  });

  it("is a no-op when nothing is installed (json: removed false), exits 0", async () => {
    const { exitCode, stdout } = await runCli(
      ["hook", "uninstall", "--global", "--format", "json"],
      { env: { HOME: home.dir } },
    );
    expect(exitCode).toBe(0);
    const json = JSON.parse(stdout.trim()) as UninstallJson;
    expect(json.command).toBe("hook uninstall");
    expect(json.ok).toBe(true);
    expect(json.removed).toBe(false);
    expect(json.scope).toBe("global");
    expect(json.path).toBe(settingsFile(home.dir));
  });

  it("removes a previously installed hook (json: removed true)", async () => {
    const env = { HOME: home.dir, FRUGL_TOKEN: "tok_test" };
    await runCli(["hook", "install", "--global"], { env });

    const { exitCode, stdout } = await runCli(
      ["hook", "uninstall", "--global", "--format", "json"],
      { env },
    );
    expect(exitCode).toBe(0);
    const json = JSON.parse(stdout.trim()) as UninstallJson;
    expect(json.removed).toBe(true);

    // The frugl SessionEnd group is gone (and the empty hooks key pruned).
    const groups = await readSessionEndGroups(home.dir);
    expect(groups).toBeUndefined();
  });

  it("round trip: install -> status installed -> uninstall -> status not installed", async () => {
    const env = { HOME: home.dir, FRUGL_TOKEN: "tok_test" };

    const install = await runCli(["hook", "install", "--global"], { env });
    expect(install.exitCode).toBe(0);

    const afterInstall = await runCli(["hook", "status", "--global", "--format", "json"], { env });
    expect((JSON.parse(afterInstall.stdout.trim()) as StatusJson).installed).toBe(true);

    const uninstall = await runCli(["hook", "uninstall", "--global", "--format", "json"], { env });
    expect((JSON.parse(uninstall.stdout.trim()) as UninstallJson).removed).toBe(true);

    const afterUninstall = await runCli(["hook", "status", "--global", "--format", "json"], {
      env,
    });
    expect((JSON.parse(afterUninstall.stdout.trim()) as StatusJson).installed).toBe(false);
  });
});
