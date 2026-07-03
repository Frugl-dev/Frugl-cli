import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { claudeHookProvider as provider, settingsPath } from "./claude-code.js";
import { UsageError } from "../lib/errors.js";

const tmpDirs: string[] = [];
function makeTmp(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "frugl-hook-"));
  tmpDirs.push(dir);
  return dir;
}
function readSettings(file: string): any {
  return JSON.parse(readFileSync(file, "utf8"));
}

afterEach(() => {
  while (tmpDirs.length > 0) rmSync(tmpDirs.pop()!, { recursive: true, force: true });
});

describe("claude-code hook install/uninstall", () => {
  it("installs a SessionEnd hook running `frugl hook run` (project scope)", () => {
    const cwd = makeTmp();
    const result = provider.install("project", { cwd });
    expect(result.status).toBe("installed");
    expect(result.path).toBe(settingsPath("project", { cwd }));
    const settings = readSettings(result.path);
    const groups = settings.hooks.SessionEnd;
    expect(groups).toHaveLength(1);
    expect(groups[0].hooks[0]).toMatchObject({ type: "command", command: "frugl hook run" });
    expect(provider.isInstalled("project", { cwd })).toBe(true);
  });

  it("is idempotent — installing twice leaves a single managed entry", () => {
    const cwd = makeTmp();
    provider.install("project", { cwd });
    provider.install("project", { cwd });
    const groups = readSettings(settingsPath("project", { cwd })).hooks.SessionEnd;
    expect(groups).toHaveLength(1);
  });

  it("replaces a legacy direct-upload entry with the hook-run entry", () => {
    const cwd = makeTmp();
    const file = settingsPath("project", { cwd });
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(
      file,
      JSON.stringify({
        hooks: {
          SessionEnd: [
            { hooks: [{ type: "command", command: "frugl upload sessions --yes --format json" }] },
          ],
        },
      }),
    );
    provider.install("project", { cwd });
    const groups = readSettings(file).hooks.SessionEnd;
    expect(groups).toHaveLength(1);
    expect(groups[0].hooks[0].command).toBe("frugl hook run");
  });

  it("preserves unrelated hooks and settings keys", () => {
    const cwd = makeTmp();
    const file = settingsPath("project", { cwd });
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(
      file,
      JSON.stringify({
        model: "opus",
        hooks: {
          SessionEnd: [{ hooks: [{ type: "command", command: "echo other" }] }],
          Stop: [{ hooks: [{ type: "command", command: "echo stop" }] }],
        },
      }),
    );

    provider.install("project", { cwd });
    const settings = readSettings(file);
    expect(settings.model).toBe("opus");
    expect(settings.hooks.Stop).toHaveLength(1);
    // The unrelated SessionEnd hook stays; ours is added alongside.
    expect(settings.hooks.SessionEnd).toHaveLength(2);
    const commands = settings.hooks.SessionEnd.flatMap((g: any) =>
      g.hooks.map((h: any) => h.command),
    );
    expect(commands).toContain("echo other");
    expect(commands).toContain("frugl hook run");
  });

  it("uninstall removes only the managed entry and leaves others intact", () => {
    const cwd = makeTmp();
    const file = settingsPath("project", { cwd });
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(
      file,
      JSON.stringify({
        hooks: { SessionEnd: [{ hooks: [{ type: "command", command: "echo other" }] }] },
      }),
    );
    provider.install("project", { cwd });
    const result = provider.uninstall("project", { cwd });
    expect(result.removed).toBe(true);
    const settings = readSettings(file);
    const commands = settings.hooks.SessionEnd.flatMap((g: any) =>
      g.hooks.map((h: any) => h.command),
    );
    expect(commands).toEqual(["echo other"]);
    expect(provider.isInstalled("project", { cwd })).toBe(false);
  });

  it("uninstall is a no-op when nothing is installed", () => {
    const cwd = makeTmp();
    const result = provider.uninstall("project", { cwd });
    expect(result.removed).toBe(false);
  });

  it("fails loud on malformed settings JSON (refuses to clobber)", () => {
    const cwd = makeTmp();
    const file = settingsPath("project", { cwd });
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, "{ not json");
    expect(() => provider.install("project", { cwd })).toThrow(UsageError);
    // The malformed file is left untouched.
    expect(readFileSync(file, "utf8")).toBe("{ not json");
  });

  it("creates the .claude dir when installing into a fresh tree", () => {
    const cwd = makeTmp();
    expect(existsSync(path.join(cwd, ".claude"))).toBe(false);
    provider.install("project", { cwd });
    expect(existsSync(settingsPath("project", { cwd }))).toBe(true);
  });

  it("detects the tool via the home .claude dir", () => {
    const home = makeTmp();
    expect(provider.detect({ home })).toBe(false);
    mkdirSync(path.join(home, ".claude"));
    expect(provider.detect({ home })).toBe(true);
  });
});
