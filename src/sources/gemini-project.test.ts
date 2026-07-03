import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { clearGeminiRegistryCache, resolveGeminiCwd } from "./gemini-project.js";
import { gemini } from "./descriptor.js";

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

describe("resolveGeminiCwd", () => {
  let home: string;
  beforeEach(() => {
    home = mkdtempSync(path.join(tmpdir(), "frugl-gemini-project-"));
    clearGeminiRegistryCache();
  });
  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
    clearGeminiRegistryCache();
  });

  function writeRegistry(projects: Record<string, string>): void {
    mkdirSync(path.join(home, ".gemini"), { recursive: true });
    writeFileSync(path.join(home, ".gemini", "projects.json"), JSON.stringify({ projects }));
  }

  function transcriptPath(name: string): string {
    return path.join(home, ".gemini", "tmp", name, "chats", "session-x.jsonl");
  }

  it("reverses the projects.json registry and verifies via the header projectHash", () => {
    const cwd = "/Users/dev/Projects/Frugl";
    writeRegistry({ [cwd]: "frugl" });
    expect(resolveGeminiCwd(transcriptPath("frugl"), sha256(cwd))).toBe(cwd);
  });

  it("disambiguates label collisions by hash; fail-closes when nothing matches", () => {
    const a = "/Users/dev/a/app";
    const b = "/Users/dev/b/app";
    writeRegistry({ [a]: "app", [b]: "app" });
    expect(resolveGeminiCwd(transcriptPath("app"), sha256(b))).toBe(b);
    expect(resolveGeminiCwd(transcriptPath("app"), sha256("/somewhere/else"))).toBeUndefined();
  });

  it("without a header hash, trusts only an unambiguous single candidate", () => {
    const a = "/Users/dev/a/app";
    const b = "/Users/dev/b/app";
    writeRegistry({ [a]: "app", [b]: "app", "/Users/dev/solo": "solo" });
    expect(resolveGeminiCwd(transcriptPath("app"), undefined)).toBeUndefined();
    expect(resolveGeminiCwd(transcriptPath("solo"), undefined)).toBe("/Users/dev/solo");
  });

  it("fail-closes on a missing or malformed registry and on unknown labels", () => {
    expect(resolveGeminiCwd(transcriptPath("frugl"), sha256("/x"))).toBeUndefined();
    writeRegistry({ "/Users/dev/Projects/Frugl": "frugl" });
    expect(resolveGeminiCwd(transcriptPath("other"), undefined)).toBeUndefined();
    expect(resolveGeminiCwd("/not/a/gemini/path.jsonl", undefined)).toBeUndefined();
  });

  it("wires into the gemini descriptor's extractMetadata (cwd for the git resolver)", () => {
    const cwd = "/Users/dev/Projects/Frugl";
    writeRegistry({ [cwd]: "frugl" });
    const meta = gemini.extractMetadata!({
      ref: {
        sourceKind: "gemini",
        absolutePath: transcriptPath("frugl"),
        byteSizeOnDisk: 1,
        mtimeMs: 1,
      },
      records: [],
      firstRecord: { sessionId: "s1", projectHash: sha256(cwd) },
    });
    expect(meta.cwd).toBe(cwd);
  });
});
