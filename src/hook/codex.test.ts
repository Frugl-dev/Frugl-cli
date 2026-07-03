import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { codexHookProvider as provider } from "./codex.js";

const tmpDirs: string[] = [];
function makeHome(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "frugl-codex-"));
  tmpDirs.push(dir);
  return dir;
}
function configFile(home: string): string {
  return path.join(home, ".codex", "config.toml");
}
function writeConfig(home: string, content: string): void {
  mkdirSync(path.join(home, ".codex"), { recursive: true });
  writeFileSync(configFile(home), content);
}

afterEach(() => {
  while (tmpDirs.length > 0) rmSync(tmpDirs.pop()!, { recursive: true, force: true });
});

describe("codex hook install/uninstall (config.toml notify)", () => {
  it("creates config.toml with the notify line when absent", () => {
    const home = makeHome();
    const result = provider.install("global", { home });
    expect(result.status).toBe("installed");
    expect(readFileSync(configFile(home), "utf8")).toBe('notify = ["frugl", "hook", "run"]\n');
    expect(provider.isInstalled("global", { home })).toBe(true);
  });

  it("inserts notify into the root table, before the first section header", () => {
    const home = makeHome();
    writeConfig(home, 'model = "o4"\n\n[profiles.fast]\nmodel = "o4-mini"\n');
    provider.install("global", { home });
    const content = readFileSync(configFile(home), "utf8");
    const notifyAt = content.indexOf("notify =");
    const headerAt = content.indexOf("[profiles.fast]");
    expect(notifyAt).toBeGreaterThan(-1);
    expect(notifyAt).toBeLessThan(headerAt);
    // The rest of the file is preserved verbatim.
    expect(content).toContain('model = "o4"');
    expect(content).toContain('model = "o4-mini"');
  });

  it("is idempotent and refreshes an existing frugl notify line", () => {
    const home = makeHome();
    writeConfig(home, 'notify = ["frugl", "upload", "sessions"]\n');
    const result = provider.install("global", { home });
    expect(result.status).toBe("installed");
    const content = readFileSync(configFile(home), "utf8");
    expect(content.match(/notify/g)).toHaveLength(1);
    expect(content).toContain('notify = ["frugl", "hook", "run"]');
  });

  it("reports a conflict on a foreign notify and leaves the file untouched", () => {
    const home = makeHome();
    const original = 'notify = ["terminal-notifier"]\nmodel = "o4"\n';
    writeConfig(home, original);
    const result = provider.install("global", { home });
    expect(result.status).toBe("conflict");
    expect(readFileSync(configFile(home), "utf8")).toBe(original);
    expect(provider.isInstalled("global", { home })).toBe(false);
  });

  it("treats a multi-line notify as foreign (no partial edits)", () => {
    const home = makeHome();
    const original = 'notify = [\n  "some-tool",\n]\n';
    writeConfig(home, original);
    const result = provider.install("global", { home });
    expect(result.status).toBe("conflict");
    expect(readFileSync(configFile(home), "utf8")).toBe(original);
  });

  it("ignores a notify key inside a section (not root table)", () => {
    const home = makeHome();
    writeConfig(home, '[other]\nnotify = ["something"]\n');
    const result = provider.install("global", { home });
    expect(result.status).toBe("installed");
    const content = readFileSync(configFile(home), "utf8");
    // Ours lands in the root table; the sectioned key is untouched.
    expect(content.startsWith('notify = ["frugl", "hook", "run"]\n')).toBe(true);
    expect(content).toContain('[other]\nnotify = ["something"]');
  });

  it("uninstall removes only our notify line", () => {
    const home = makeHome();
    writeConfig(home, 'model = "o4"\n');
    provider.install("global", { home });
    const result = provider.uninstall("global", { home });
    expect(result.removed).toBe(true);
    const content = readFileSync(configFile(home), "utf8");
    expect(content).not.toContain("notify");
    expect(content).toContain('model = "o4"');
  });

  it("uninstall never touches a foreign notify", () => {
    const home = makeHome();
    const original = 'notify = ["terminal-notifier"]\n';
    writeConfig(home, original);
    const result = provider.uninstall("global", { home });
    expect(result.removed).toBe(false);
    expect(readFileSync(configFile(home), "utf8")).toBe(original);
  });

  it("detects the tool via the home .codex dir", () => {
    const home = makeHome();
    expect(provider.detect({ home })).toBe(false);
    mkdirSync(path.join(home, ".codex"));
    expect(provider.detect({ home })).toBe(true);
  });
});
