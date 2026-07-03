import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { cursorHookProvider as provider } from "./cursor.js";
import { UsageError } from "../lib/errors.js";

const tmpDirs: string[] = [];
function makeTmp(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "frugl-cursor-"));
  tmpDirs.push(dir);
  return dir;
}
function hooksFile(cwd: string): string {
  return path.join(cwd, ".cursor", "hooks.json");
}
function readHooks(file: string): any {
  return JSON.parse(readFileSync(file, "utf8"));
}

afterEach(() => {
  while (tmpDirs.length > 0) rmSync(tmpDirs.pop()!, { recursive: true, force: true });
});

describe("cursor hook install/uninstall (hooks.json)", () => {
  it("installs a stop hook with version 1 into a fresh tree", () => {
    const cwd = makeTmp();
    const result = provider.install("project", { cwd });
    expect(result.status).toBe("installed");
    const parsed = readHooks(hooksFile(cwd));
    expect(parsed.version).toBe(1);
    expect(parsed.hooks.stop).toEqual([{ command: "frugl hook run" }]);
    expect(provider.isInstalled("project", { cwd })).toBe(true);
  });

  it("is idempotent and preserves foreign entries and version", () => {
    const cwd = makeTmp();
    mkdirSync(path.join(cwd, ".cursor"), { recursive: true });
    writeFileSync(
      hooksFile(cwd),
      JSON.stringify({
        version: 2,
        hooks: { stop: [{ command: "./notify.sh" }], beforeSubmitPrompt: [{ command: "./x" }] },
      }),
    );
    provider.install("project", { cwd });
    provider.install("project", { cwd });
    const parsed = readHooks(hooksFile(cwd));
    expect(parsed.version).toBe(2);
    expect(parsed.hooks.beforeSubmitPrompt).toEqual([{ command: "./x" }]);
    expect(parsed.hooks.stop).toEqual([{ command: "./notify.sh" }, { command: "frugl hook run" }]);
  });

  it("migrates our entry from another event to stop", () => {
    const cwd = makeTmp();
    mkdirSync(path.join(cwd, ".cursor"), { recursive: true });
    writeFileSync(
      hooksFile(cwd),
      JSON.stringify({ version: 1, hooks: { sessionEnd: [{ command: "frugl hook run" }] } }),
    );
    provider.install("project", { cwd });
    const parsed = readHooks(hooksFile(cwd));
    expect(parsed.hooks.sessionEnd).toBeUndefined();
    expect(parsed.hooks.stop).toEqual([{ command: "frugl hook run" }]);
  });

  it("uninstall removes our entries from every event, keeping others", () => {
    const cwd = makeTmp();
    mkdirSync(path.join(cwd, ".cursor"), { recursive: true });
    writeFileSync(
      hooksFile(cwd),
      JSON.stringify({
        version: 1,
        hooks: {
          stop: [{ command: "frugl hook run" }, { command: "./notify.sh" }],
          sessionEnd: [{ command: "frugl upload sessions --yes" }],
        },
      }),
    );
    const result = provider.uninstall("project", { cwd });
    expect(result.removed).toBe(true);
    const parsed = readHooks(hooksFile(cwd));
    expect(parsed.hooks.stop).toEqual([{ command: "./notify.sh" }]);
    expect(parsed.hooks.sessionEnd).toBeUndefined();
  });

  it("uninstall is a no-op without a hooks file", () => {
    const cwd = makeTmp();
    expect(provider.uninstall("project", { cwd }).removed).toBe(false);
  });

  it("fails loud on malformed hooks.json (refuses to clobber)", () => {
    const cwd = makeTmp();
    mkdirSync(path.join(cwd, ".cursor"), { recursive: true });
    writeFileSync(hooksFile(cwd), "[1, 2");
    expect(() => provider.install("project", { cwd })).toThrow(UsageError);
    expect(readFileSync(hooksFile(cwd), "utf8")).toBe("[1, 2");
  });

  it("detects the tool via ~/.cursor or the IDE app-support dir", () => {
    const home = makeTmp();
    expect(provider.detect({ home })).toBe(false);
    mkdirSync(path.join(home, "Library", "Application Support", "Cursor"), { recursive: true });
    expect(provider.detect({ home })).toBe(true);
  });
});
