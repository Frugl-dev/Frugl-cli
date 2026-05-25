import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { detectProviders, PROVIDERS } from "./providers.js";

describe("detectProviders", () => {
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(path.join(tmpdir(), "poppi-detect-"));
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  it("returns nothing on a machine with no provider data", async () => {
    expect(await detectProviders({ homeDir: home })).toEqual([]);
  });

  it("returns only detected providers, preserving registry order", async () => {
    // Seed gemini and claude (out of registry order) plus codex.
    mkdirSync(path.join(home, ".gemini", "tmp"), { recursive: true });
    mkdirSync(path.join(home, ".claude", "projects"), { recursive: true });
    mkdirSync(path.join(home, ".codex", "sessions"), { recursive: true });

    const detected = await detectProviders({ homeDir: home });
    expect(detected.map((d) => d.descriptor.id)).toEqual(["claude", "codex", "gemini"]);
  });

  it("marks only Claude Code as supported in v1", async () => {
    const claude = PROVIDERS.find((p) => p.id === "claude");
    expect(claude?.supported).toBe(true);
    expect(claude?.source).toBeDefined();
    expect(claude?.deriveProjects).toBeDefined();
    for (const id of ["codex", "cursor", "gemini"] as const) {
      const p = PROVIDERS.find((d) => d.id === id);
      expect(p?.supported).toBe(false);
      expect(p?.source).toBeUndefined();
      expect(p?.deriveProjects).toBeUndefined();
    }
  });

  it("propagates a non-ENOENT probe error rather than swallowing it", async () => {
    if (process.platform === "win32" || process.getuid?.() === 0) return;
    const locked = path.join(home, "locked");
    mkdirSync(locked, { recursive: true });
    // Create a cursor file so something would be detectable, then lock the home.
    const { chmodSync } = await import("node:fs");
    writeFileSync(path.join(locked, "marker"), "");
    chmodSync(locked, 0o000);
    try {
      await expect(detectProviders({ homeDir: locked })).rejects.toThrow(
        /permission denied|EACCES|EPERM/i,
      );
    } finally {
      chmodSync(locked, 0o755);
    }
  });
});
