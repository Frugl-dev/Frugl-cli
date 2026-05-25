import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { probeClaude, probeCodex, probeCursor, probeGemini } from "./probe.js";

describe("provider probes", () => {
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(path.join(tmpdir(), "poppi-probe-"));
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  it("returns false when a provider root is absent", async () => {
    expect(await probeClaude({ homeDir: home })).toBe(false);
    expect(await probeCodex({ homeDir: home })).toBe(false);
    expect(await probeCursor({ homeDir: home })).toBe(false);
    expect(await probeGemini({ homeDir: home })).toBe(false);
  });

  it("returns true when each provider root is present", async () => {
    mkdirSync(path.join(home, ".claude", "projects"), { recursive: true });
    mkdirSync(path.join(home, ".codex", "sessions"), { recursive: true });
    mkdirSync(path.join(home, ".gemini", "tmp"), { recursive: true });
    const cursorDir = path.join(
      home,
      "Library",
      "Application Support",
      "Cursor",
      "User",
      "globalStorage",
    );
    mkdirSync(cursorDir, { recursive: true });
    writeFileSync(path.join(cursorDir, "state.vscdb"), "");

    expect(await probeClaude({ homeDir: home })).toBe(true);
    expect(await probeCodex({ homeDir: home })).toBe(true);
    expect(await probeCursor({ homeDir: home })).toBe(true);
    expect(await probeGemini({ homeDir: home })).toBe(true);
  });

  it("surfaces a non-ENOENT error (e.g. EACCES) instead of returning false", async () => {
    if (process.platform === "win32" || process.getuid?.() === 0) return; // chmod no-op
    const locked = path.join(home, "locked");
    mkdirSync(locked, { recursive: true });
    chmodSync(locked, 0o000);
    try {
      await expect(probeClaude({ homeDir: locked })).rejects.toThrow(
        /permission denied|EACCES|EPERM/i,
      );
    } finally {
      chmodSync(locked, 0o755);
    }
  });
});
