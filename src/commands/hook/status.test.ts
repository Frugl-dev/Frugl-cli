import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { makeTempDir, type TempDir } from "../../e2e/helpers/fixtures.js";
import { runCli } from "../../e2e/helpers/spawn.js";

// Drives `hook status` via the spawned CLI against a throwaway HOME (--global),
// asserting the per-provider JSON shape across not-installed and installed states.

interface ProviderStatus {
  id: string;
  displayName: string;
  detected: boolean;
  installed: boolean;
  path: string;
}

interface StatusJson {
  command: string;
  ok: boolean;
  scope: string;
  providers: ProviderStatus[];
}

describe("frugl hook status", { timeout: 30_000 }, () => {
  let home: TempDir;

  beforeEach(async () => {
    home = await makeTempDir();
  });

  afterEach(async () => {
    await home.cleanup();
  });

  it("reports every provider not-installed for a fresh HOME (json shape)", async () => {
    const { exitCode, stdout } = await runCli(["hook", "status", "--global", "--format", "json"], {
      env: { HOME: home.dir },
    });
    expect(exitCode).toBe(0);

    const json = JSON.parse(stdout.trim()) as StatusJson;
    expect(json.command).toBe("hook status");
    expect(json.ok).toBe(true);
    expect(json.scope).toBe("global");
    expect(json.providers.map((p) => p.id).toSorted()).toEqual([
      "claude",
      "codex",
      "cursor",
      "gemini",
    ]);
    for (const p of json.providers) {
      expect(p.detected).toBe(false);
      expect(p.installed).toBe(false);
    }
    const claude = json.providers.find((p) => p.id === "claude")!;
    expect(claude.path).toBe(path.join(home.dir, ".claude", "settings.json"));
  });

  it("reports not-installed in human output for a fresh HOME", async () => {
    const { exitCode, stdout } = await runCli(["hook", "status", "--global"], {
      env: { HOME: home.dir },
    });
    expect(exitCode).toBe(0);
    expect(stdout).toMatch(/Claude Code\s+not detected/);
  });

  it("reports installed + detected after install (json shape)", async () => {
    await mkdir(path.join(home.dir, ".claude"), { recursive: true });
    const env = { HOME: home.dir, FRUGL_TOKEN: "tok_test" };
    await runCli(["hook", "install", "--global"], { env });

    const { exitCode, stdout } = await runCli(["hook", "status", "--global", "--format", "json"], {
      env,
    });
    expect(exitCode).toBe(0);
    const json = JSON.parse(stdout.trim()) as StatusJson;
    const claude = json.providers.find((p) => p.id === "claude")!;
    expect(claude.detected).toBe(true);
    expect(claude.installed).toBe(true);
    const gemini = json.providers.find((p) => p.id === "gemini")!;
    expect(gemini.installed).toBe(false);
  });
});
