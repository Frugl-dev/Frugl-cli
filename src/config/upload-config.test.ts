import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { loadUploadConfig, resolveConfigSelection } from "./upload-config.js";
import { UsageError } from "../lib/errors.js";
import type { DetectedProvider, ProjectGroup } from "../sources/providers.js";

const tmpDirs: string[] = [];
function makeTmp(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "frugl-cfg-"));
  tmpDirs.push(dir);
  return dir;
}
function writeConfig(dir: string, contents: string): string {
  const p = path.join(dir, "frugl.config.json");
  writeFileSync(p, contents);
  return p;
}

afterEach(() => {
  while (tmpDirs.length > 0) rmSync(tmpDirs.pop()!, { recursive: true, force: true });
});

describe("loadUploadConfig", () => {
  it("returns null when no config is found (default scope)", () => {
    const dir = makeTmp();
    expect(loadUploadConfig({ cwd: dir, home: dir })).toBeNull();
  });

  it("throws when an explicit --config path does not exist", () => {
    const dir = makeTmp();
    expect(() => loadUploadConfig({ explicitPath: path.join(dir, "nope.json") })).toThrow(
      UsageError,
    );
  });

  it("fails closed on malformed JSON", () => {
    const dir = makeTmp();
    writeConfig(dir, "{ not json ");
    expect(() => loadUploadConfig({ cwd: dir, home: dir })).toThrow(UsageError);
  });

  it("fails closed on an invalid schema version", () => {
    const dir = makeTmp();
    writeConfig(dir, JSON.stringify({ schemaVersion: 2 }));
    expect(() => loadUploadConfig({ cwd: dir, home: dir })).toThrow(UsageError);
  });

  it("fails closed on unknown keys (typo protection)", () => {
    const dir = makeTmp();
    writeConfig(dir, JSON.stringify({ schemaVersion: 1, projetcs: {} }));
    expect(() => loadUploadConfig({ cwd: dir, home: dir })).toThrow(UsageError);
  });

  it("loads a valid config", () => {
    const dir = makeTmp();
    writeConfig(
      dir,
      JSON.stringify({
        schemaVersion: 1,
        providers: ["claude"],
        projects: { include: ["~/work/**"], exclude: ["~/work/secret/**"] },
        upload: { concurrency: 4, linkPrs: false },
      }),
    );
    const config = loadUploadConfig({ cwd: dir, home: dir });
    expect(config?.providers).toEqual(["claude"]);
    expect(config?.projects?.include).toEqual(["~/work/**"]);
  });

  it("discovers the nearest config walking up to home", () => {
    const home = makeTmp();
    const nested = path.join(home, "a", "b");
    mkdirSync(nested, { recursive: true });
    writeConfig(home, JSON.stringify({ schemaVersion: 1, providers: ["claude"] }));
    const config = loadUploadConfig({ cwd: nested, home });
    expect(config?.providers).toEqual(["claude"]);
  });
});

function writeProjectFile(dir: string, contents: string): void {
  writeFileSync(path.join(dir, ".frugl.json"), contents);
}

describe("loadUploadConfig — .frugl.json#upload precedence (spec 007)", () => {
  it("reads the .frugl.json upload block in preference to frugl.config.json", () => {
    const dir = makeTmp();
    // Both files present: the canonical .frugl.json wins.
    writeProjectFile(
      dir,
      JSON.stringify({
        version: 1,
        org: "acme",
        upload: {
          concurrency: 8,
          linkPrs: true,
          providers: ["claude-code"],
          projects: { include: ["~/work/**"] },
        },
      }),
    );
    writeConfig(dir, JSON.stringify({ schemaVersion: 1, providers: ["cursor"] }));

    const config = loadUploadConfig({ cwd: dir, home: dir });
    expect(config?.providers).toEqual(["claude-code"]);
    expect(config?.projects?.include).toEqual(["~/work/**"]);
    expect(config?.upload?.concurrency).toBe(8);
    expect(config?.upload?.linkPrs).toBe(true);
    // The top-level org is carried into UploadConfig.upload.org.
    expect(config?.upload?.org).toBe("acme");
  });

  it("falls back to frugl.config.json when .frugl.json has no upload block", () => {
    const dir = makeTmp();
    // .frugl.json carries only an org/endpoint, no upload scope.
    writeProjectFile(dir, JSON.stringify({ version: 1, org: "acme" }));
    writeConfig(dir, JSON.stringify({ schemaVersion: 1, providers: ["cursor"] }));

    const config = loadUploadConfig({ cwd: dir, home: dir });
    expect(config?.providers).toEqual(["cursor"]);
  });

  it("fails closed on a malformed .frugl.json", () => {
    const dir = makeTmp();
    writeProjectFile(dir, "{ not json ");
    expect(() => loadUploadConfig({ cwd: dir, home: dir })).toThrow(UsageError);
  });

  it("tolerates a legacy endpoint-only pin (no version) — falls through, no throw", () => {
    const dir = makeTmp();
    // Pre-v1 self-host pin: only `endpoint`, no `version`. Must NOT break upload.
    writeProjectFile(dir, JSON.stringify({ endpoint: "https://frugl.internal" }));
    expect(loadUploadConfig({ cwd: dir, home: dir })).toBeNull();
  });

  it("still honors an explicit --config path pointing at frugl.config.json", () => {
    const dir = makeTmp();
    // Even with a .frugl.json present, an explicit --config wins as before.
    writeProjectFile(dir, JSON.stringify({ version: 1, upload: { providers: ["claude-code"] } }));
    const explicit = writeConfig(dir, JSON.stringify({ schemaVersion: 1, providers: ["cursor"] }));
    const config = loadUploadConfig({ explicitPath: explicit });
    expect(config?.providers).toEqual(["cursor"]);
  });
});

function provider(id: "claude" | "cursor", supported: boolean): DetectedProvider {
  return { descriptor: { id, displayName: id, supported } } as unknown as DetectedProvider;
}
function group(
  providerId: "claude" | "cursor",
  projectId: string,
  displayName: string,
): ProjectGroup {
  return { providerId, projectId, displayName, sessions: [], sessionCount: 0 };
}

describe("resolveConfigSelection", () => {
  const home = "/home/u";
  const detected = [provider("claude", true), provider("cursor", false)];
  const groups = [
    group("claude", "p-work", "/home/u/work/repo"),
    group("claude", "p-secret", "/home/u/work/secret/client"),
    group("claude", "p-personal", "/home/u/personal/side"),
  ];

  it("restricts providers to the configured, supported set", () => {
    const sel = resolveConfigSelection(
      { schemaVersion: 1, providers: ["claude"] },
      detected,
      groups,
      home,
    );
    expect(sel.providerIds).toEqual(["claude"]);
  });

  it("defaults to all supported providers when none are configured", () => {
    const sel = resolveConfigSelection({ schemaVersion: 1 }, detected, groups, home);
    expect(sel.providerIds).toEqual(["claude"]); // cursor is unsupported
  });

  it("includes only projects matching include globs", () => {
    const sel = resolveConfigSelection(
      { schemaVersion: 1, projects: { include: ["~/work/**"] } },
      detected,
      groups,
      home,
    );
    expect(sel.projectIds).toEqual(["p-work", "p-secret"]);
  });

  it("exclude wins over include", () => {
    const sel = resolveConfigSelection(
      { schemaVersion: 1, projects: { include: ["~/work/**"], exclude: ["~/work/secret/**"] } },
      detected,
      groups,
      home,
    );
    expect(sel.projectIds).toEqual(["p-work"]);
  });

  it("selects all projects when no project filters are set", () => {
    const sel = resolveConfigSelection({ schemaVersion: 1 }, detected, groups, home);
    expect(sel.projectIds).toEqual(["p-work", "p-secret", "p-personal"]);
  });
});
