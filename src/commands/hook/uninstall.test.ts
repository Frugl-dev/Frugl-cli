import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { makeTempDir, type TempDir } from "../../e2e/helpers/fixtures.js";
import { runCli } from "../../e2e/helpers/spawn.js";

// Drives `hook uninstall` via the spawned CLI against a throwaway HOME
// (--global), covering the no-op case, multi-provider removal, the JSON shape,
// and a full install -> status -> uninstall round trip.

interface ProviderRemoval {
  id: string;
  displayName: string;
  path: string;
  removed: boolean;
}

interface UninstallJson {
  command: string;
  ok: boolean;
  scope: string;
  providers: ProviderRemoval[];
}

interface StatusJson {
  providers: Array<{ id: string; installed: boolean }>;
}

function removed(json: UninstallJson, id: string): boolean {
  return json.providers.find((p) => p.id === id)?.removed ?? false;
}

describe("frugl hook uninstall", { timeout: 30_000 }, () => {
  let home: TempDir;

  beforeEach(async () => {
    home = await makeTempDir();
  });

  afterEach(async () => {
    await home.cleanup();
  });

  it("is a no-op when nothing is installed (all removed:false), exits 0", async () => {
    const { exitCode, stdout } = await runCli(
      ["hook", "uninstall", "--global", "--format", "json"],
      { env: { HOME: home.dir } },
    );
    expect(exitCode).toBe(0);
    const json = JSON.parse(stdout.trim()) as UninstallJson;
    expect(json.command).toBe("hook uninstall");
    expect(json.ok).toBe(true);
    expect(json.scope).toBe("global");
    expect(json.providers).toHaveLength(4);
    for (const p of json.providers) expect(p.removed).toBe(false);
  });

  it("removes previously installed hooks across providers", async () => {
    await mkdir(path.join(home.dir, ".claude"), { recursive: true });
    await mkdir(path.join(home.dir, ".codex"), { recursive: true });
    const env = { HOME: home.dir, FRUGL_TOKEN: "tok_test" };
    await runCli(["hook", "install", "--global"], { env });

    const { exitCode, stdout } = await runCli(
      ["hook", "uninstall", "--global", "--format", "json"],
      { env },
    );
    expect(exitCode).toBe(0);
    const json = JSON.parse(stdout.trim()) as UninstallJson;
    expect(removed(json, "claude")).toBe(true);
    expect(removed(json, "codex")).toBe(true);
    expect(removed(json, "gemini")).toBe(false);

    // The frugl SessionEnd group is gone (and the empty hooks key pruned).
    const settings = JSON.parse(
      await readFile(path.join(home.dir, ".claude", "settings.json"), "utf8"),
    ) as { hooks?: unknown };
    expect(settings.hooks).toBeUndefined();
    const codexConfig = await readFile(path.join(home.dir, ".codex", "config.toml"), "utf8");
    expect(codexConfig).not.toContain("notify");
  });

  it("round trip: install -> status installed -> uninstall -> status not installed", async () => {
    await mkdir(path.join(home.dir, ".claude"), { recursive: true });
    const env = { HOME: home.dir, FRUGL_TOKEN: "tok_test" };

    const install = await runCli(["hook", "install", "--global"], { env });
    expect(install.exitCode).toBe(0);

    const installedOf = (raw: string): boolean =>
      (JSON.parse(raw.trim()) as StatusJson).providers.find((p) => p.id === "claude")!.installed;

    const afterInstall = await runCli(["hook", "status", "--global", "--format", "json"], { env });
    expect(installedOf(afterInstall.stdout)).toBe(true);

    const uninstall = await runCli(["hook", "uninstall", "--global", "--format", "json"], { env });
    expect(removed(JSON.parse(uninstall.stdout.trim()) as UninstallJson, "claude")).toBe(true);

    const afterUninstall = await runCli(["hook", "status", "--global", "--format", "json"], {
      env,
    });
    expect(installedOf(afterUninstall.stdout)).toBe(false);
  });
});
