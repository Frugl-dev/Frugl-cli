import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  captureCodexArtifacts,
  captureCursorArtifacts,
  captureGeminiArtifacts,
  type ArtifactsPayload,
} from "./artifacts.js";

describe("artifact-loadout capture (codex/gemini/cursor)", () => {
  let home: string;
  let repo: string;
  beforeEach(() => {
    home = mkdtempSync(path.join(tmpdir(), "frugl-artifacts-home-"));
    repo = mkdtempSync(path.join(tmpdir(), "frugl-artifacts-repo-"));
    mkdirSync(path.join(repo, ".git"), { recursive: true });
  });
  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
    rmSync(repo, { recursive: true, force: true });
  });

  function parse(text: string): ArtifactsPayload {
    return JSON.parse(text) as ArtifactsPayload;
  }

  it("codex: measures global + project AGENTS.md and names config.toml MCP servers", () => {
    mkdirSync(path.join(home, ".codex"), { recursive: true });
    writeFileSync(path.join(home, ".codex", "AGENTS.md"), "be brief");
    writeFileSync(
      path.join(home, ".codex", "config.toml"),
      [
        'model = "gpt-5.5"',
        "[mcp_servers.railway]",
        'command = "npx SECRET --key=abc"',
        '[mcp_servers."supa base"]',
      ].join("\n"),
    );
    writeFileSync(path.join(repo, "AGENTS.md"), "x".repeat(1200));
    const payload = parse(captureCodexArtifacts({ homeDir: home, cwd: repo }));
    expect(payload.schema).toBe("frugl.context-artifacts");
    expect(payload.tool).toBe("codex");
    expect(payload.items).toEqual([
      { category: "memory_files", name: "~/.codex/AGENTS.md", chars: 8 },
      { category: "memory_files", name: "AGENTS.md (codex project)", chars: 1200 },
      { category: "mcp_tools", name: "railway", chars: null },
      { category: "mcp_tools", name: "supa base", chars: null },
    ]);
    // Names + sizes only: no absolute paths, no file contents, no MCP targets.
    const raw = JSON.stringify(payload);
    expect(raw).not.toContain(home);
    expect(raw).not.toContain("SECRET");
    expect(raw).not.toContain("be brief");
  });

  it("gemini: measures GEMINI.md chain and names settings.json mcpServers", () => {
    mkdirSync(path.join(home, ".gemini"), { recursive: true });
    writeFileSync(path.join(home, ".gemini", "GEMINI.md"), "y".repeat(964));
    writeFileSync(
      path.join(home, ".gemini", "settings.json"),
      JSON.stringify({ mcpServers: { railway: { command: "npx SECRET" } } }),
    );
    writeFileSync(path.join(repo, "GEMINI.md"), "z".repeat(300));
    const payload = parse(captureGeminiArtifacts({ homeDir: home, cwd: repo }));
    expect(payload.tool).toBe("gemini");
    expect(payload.items).toEqual([
      { category: "memory_files", name: "~/.gemini/GEMINI.md", chars: 964 },
      { category: "memory_files", name: "GEMINI.md (gemini project)", chars: 300 },
      { category: "mcp_tools", name: "railway", chars: null },
    ]);
    expect(JSON.stringify(payload)).not.toContain("SECRET");
  });

  it("cursor: measures AGENTS.md, .cursor/rules/*.mdc, and legacy .cursorrules", () => {
    writeFileSync(path.join(repo, "AGENTS.md"), "a".repeat(100));
    mkdirSync(path.join(repo, ".cursor", "rules"), { recursive: true });
    writeFileSync(path.join(repo, ".cursor", "rules", "style.mdc"), "b".repeat(50));
    writeFileSync(path.join(repo, ".cursor", "rules", "notes.txt"), "ignored");
    writeFileSync(path.join(repo, ".cursorrules"), "c".repeat(25));
    const payload = parse(captureCursorArtifacts({ homeDir: home, cwd: repo }));
    expect(payload.tool).toBe("cursor");
    expect(payload.items).toEqual([
      { category: "memory_files", name: "AGENTS.md (cursor project)", chars: 100 },
      { category: "memory_files", name: ".cursor/rules/style.mdc", chars: 50 },
      { category: "memory_files", name: ".cursorrules", chars: 25 },
    ]);
  });

  it("captures from a cwd below the repo root (root files still found)", () => {
    writeFileSync(path.join(repo, "GEMINI.md"), "root memory");
    const nested = path.join(repo, "packages", "web");
    mkdirSync(nested, { recursive: true });
    const payload = parse(captureGeminiArtifacts({ homeDir: home, cwd: nested }));
    expect(payload.items).toEqual([
      { category: "memory_files", name: "GEMINI.md (gemini project)", chars: 11 },
    ]);
  });

  it("fails closed when a tool has no artifacts at all (nothing to snapshot)", () => {
    expect(() => captureCodexArtifacts({ homeDir: home, cwd: repo })).toThrow(
      /no codex context artifacts/i,
    );
  });

  it("payload is timestamp-free so an unchanged loadout hashes identically", () => {
    writeFileSync(path.join(repo, "AGENTS.md"), "stable");
    const a = captureCursorArtifacts({ homeDir: home, cwd: repo });
    const b = captureCursorArtifacts({ homeDir: home, cwd: repo });
    expect(a).toBe(b);
  });
});
