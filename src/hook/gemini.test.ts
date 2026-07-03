import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { geminiHookProvider as provider } from "./gemini.js";

// The heavy lifting (idempotency, foreign-hook preservation, malformed-JSON
// refusal) is shared with Claude Code via settings-hooks.ts and covered in
// claude-code.test.ts; here we pin Gemini's own file location and event.

const tmpDirs: string[] = [];
function makeTmp(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "frugl-gemini-"));
  tmpDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tmpDirs.length > 0) rmSync(tmpDirs.pop()!, { recursive: true, force: true });
});

describe("gemini hook install/uninstall", () => {
  it("writes a SessionEnd hook-run entry into .gemini/settings.json", () => {
    const cwd = makeTmp();
    const result = provider.install("project", { cwd });
    expect(result.status).toBe("installed");
    expect(result.path).toBe(path.join(cwd, ".gemini", "settings.json"));
    const settings = JSON.parse(readFileSync(result.path, "utf8"));
    expect(settings.hooks.SessionEnd).toHaveLength(1);
    expect(settings.hooks.SessionEnd[0].hooks[0]).toMatchObject({
      type: "command",
      command: "frugl hook run",
    });
    expect(provider.isInstalled("project", { cwd })).toBe(true);
  });

  it("global scope targets ~/.gemini/settings.json and preserves other keys", () => {
    const home = makeTmp();
    const file = path.join(home, ".gemini", "settings.json");
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify({ theme: "dark" }));
    provider.install("global", { home });
    const settings = JSON.parse(readFileSync(file, "utf8"));
    expect(settings.theme).toBe("dark");
    expect(settings.hooks.SessionEnd).toHaveLength(1);
    expect(provider.uninstall("global", { home }).removed).toBe(true);
    expect(JSON.parse(readFileSync(file, "utf8")).hooks).toBeUndefined();
  });

  it("detects the tool via the home .gemini dir", () => {
    const home = makeTmp();
    expect(provider.detect({ home })).toBe(false);
    mkdirSync(path.join(home, ".gemini"));
    expect(provider.detect({ home })).toBe(true);
  });
});
