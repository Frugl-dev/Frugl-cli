import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  PROJECT_CONFIG_FILENAME,
  findProjectConfigDir,
  readProjectConfig,
  writeProjectConfig,
} from "./project-config.js";
import { UsageError } from "../lib/errors.js";

function write(dir: string, contents: string): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, PROJECT_CONFIG_FILENAME), contents, "utf8");
}

describe("readProjectConfig", () => {
  let root: string;
  const savedConfigEnv = process.env["FRUGL_CONFIG"];

  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), "frugl-pc-"));
    delete process.env["FRUGL_CONFIG"];
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
    if (savedConfigEnv === undefined) delete process.env["FRUGL_CONFIG"];
    else process.env["FRUGL_CONFIG"] = savedConfigEnv;
  });

  it("returns null when no .frugl.json exists anywhere up the tree", () => {
    const deep = path.join(root, "a", "b");
    mkdirSync(deep, { recursive: true });
    expect(readProjectConfig(deep, root)).toBeNull();
  });

  it("returns null for an otherwise-empty file", () => {
    write(root, "{}");
    expect(readProjectConfig(root, root)).toBeNull();
  });

  it("parses a valid config", () => {
    write(
      root,
      JSON.stringify({
        version: 1,
        endpoint: "https://frugl.internal",
        org: "acme",
        upload: { minCost: 25, providers: ["claude-code"] },
      }),
    );
    const cfg = readProjectConfig(root, root);
    expect(cfg?.org).toBe("acme");
    expect(cfg?.endpoint).toBe("https://frugl.internal");
    expect(cfg?.upload?.minCost).toBe(25);
    expect(cfg?.upload?.providers).toEqual(["claude-code"]);
  });

  it("parses upload.auto, upload.enabled, and snapshot.enabled", () => {
    write(
      root,
      JSON.stringify({
        version: 1,
        org: "acme",
        upload: { auto: true, enabled: false },
        snapshot: { enabled: false },
      }),
    );
    const cfg = readProjectConfig(root, root);
    expect(cfg?.upload?.auto).toBe(true);
    expect(cfg?.upload?.enabled).toBe(false);
    expect(cfg?.snapshot?.enabled).toBe(false);
  });

  it("FAIL-CLOSED: throws on unknown key inside snapshot block", () => {
    write(root, JSON.stringify({ version: 1, snapshot: { enabled: false, typo: true } }));
    expect(() => readProjectConfig(root, root)).toThrow(UsageError);
  });

  it("walks UP from a nested cwd to the project-root config", () => {
    write(root, JSON.stringify({ version: 1, org: "acme" }));
    const deep = path.join(root, "packages", "app", "src");
    mkdirSync(deep, { recursive: true });
    expect(readProjectConfig(deep, root)?.org).toBe("acme");
  });

  it("FAIL-CLOSED: throws on malformed JSON rather than ignoring it", () => {
    write(root, "{ not json");
    expect(() => readProjectConfig(root, root)).toThrow(UsageError);
  });

  it("FAIL-CLOSED: throws when keys are present but version is missing", () => {
    write(root, JSON.stringify({ org: "acme" }));
    expect(() => readProjectConfig(root, root)).toThrow(UsageError);
  });

  it("tolerates the legacy endpoint-only pin (only `endpoint`, no version) as null", () => {
    // Back-compat: a pre-v1 self-host pin (`.frugl.json` = { endpoint }) is read
    // by cloud/project-pin.ts for endpoint resolution; readProjectConfig must
    // treat it as "no v1 config" (null) rather than throwing, so `frugl upload`
    // keeps working in existing self-host repos.
    write(root, JSON.stringify({ endpoint: "https://frugl.internal" }));
    expect(readProjectConfig(root, root)).toBeNull();
  });

  it("FAIL-CLOSED: a versioned config with a bad field still throws", () => {
    // Declares itself v1 but `org` violates the schema (empty string) — a real
    // corrupt config, NOT a legacy pin, so it must fail closed.
    write(root, JSON.stringify({ version: 1, org: "" }));
    expect(() => readProjectConfig(root, root)).toThrow(UsageError);
  });

  it("FAIL-CLOSED: endpoint + other keys but no version still throws (not a pin)", () => {
    // endpoint present alongside config-ish keys, no `version: 1` → corrupt
    // config, not the bare legacy pin shape; must throw.
    write(root, JSON.stringify({ endpoint: "https://frugl.internal", org: "acme" }));
    expect(() => readProjectConfig(root, root)).toThrow(UsageError);
  });

  it("FAIL-CLOSED: throws on an unknown top-level key (typo protection)", () => {
    write(root, JSON.stringify({ version: 1, orgg: "acme" }));
    expect(() => readProjectConfig(root, root)).toThrow(UsageError);
  });

  it("FRUGL_CONFIG overrides discovery with an explicit path", () => {
    const other = mkdtempSync(path.join(tmpdir(), "frugl-pc-alt-"));
    try {
      const explicit = path.join(other, "custom.json");
      writeFileSync(explicit, JSON.stringify({ version: 1, org: "from-env" }), "utf8");
      // The cwd has its own config that must be ignored in favor of the override.
      write(root, JSON.stringify({ version: 1, org: "from-cwd" }));
      process.env["FRUGL_CONFIG"] = explicit;
      expect(readProjectConfig(root, root)?.org).toBe("from-env");
    } finally {
      rmSync(other, { recursive: true, force: true });
    }
  });

  it("FRUGL_CONFIG pointing at a missing file fails closed", () => {
    process.env["FRUGL_CONFIG"] = path.join(root, "nope.json");
    expect(() => readProjectConfig(root, root)).toThrow(UsageError);
  });
});

describe("writeProjectConfig", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), "frugl-pcw-"));
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  function read(): string {
    return readFileSync(path.join(root, PROJECT_CONFIG_FILENAME), "utf8");
  }

  it("creates a file with $schema + version and a trailing newline", () => {
    const res = writeProjectConfig({ org: "acme" }, { dir: root });
    expect(res.changed).toBe(true);
    const raw = read();
    expect(raw.endsWith("\n")).toBe(true);
    const parsed = JSON.parse(raw);
    expect(parsed.$schema).toBe("https://app.frugl.dev/schema/frugl.v1.json");
    expect(parsed.version).toBe(1);
    expect(parsed.org).toBe("acme");
  });

  it("emits keys in fixed order: $schema, version, endpoint, org, upload, snapshot", () => {
    writeProjectConfig(
      {
        org: "acme",
        endpoint: "https://frugl.internal",
        upload: { minCost: 25 },
        snapshot: { enabled: false },
      },
      { dir: root },
    );
    expect(Object.keys(JSON.parse(read()))).toEqual([
      "$schema",
      "version",
      "endpoint",
      "org",
      "upload",
      "snapshot",
    ]);
  });

  it("omits managed keys equal to their built-in default", () => {
    writeProjectConfig(
      { org: "acme", upload: { minCost: 10, snapshot: true, concurrency: 4, linkPrs: false } },
      { dir: root },
    );
    // Every upload value equals its default → the whole block is omitted.
    expect(JSON.parse(read()).upload).toBeUndefined();
  });

  it("never pins the public default endpoint", () => {
    writeProjectConfig({ org: "acme", endpoint: "https://app.frugl.dev" }, { dir: root });
    expect(JSON.parse(read()).endpoint).toBeUndefined();
  });

  it("only writes endpoint when one is provided", () => {
    writeProjectConfig({ org: "acme" }, { dir: root });
    expect(JSON.parse(read()).endpoint).toBeUndefined();
    writeProjectConfig({ endpoint: "https://frugl.internal" }, { dir: root });
    expect(JSON.parse(read()).endpoint).toBe("https://frugl.internal");
  });

  it("merges over an existing file, preserving unknown keys verbatim", () => {
    write(
      root,
      JSON.stringify(
        {
          $schema: "https://app.frugl.dev/schema/frugl.v1.json",
          version: 1,
          org: "old",
          upload: { minCost: 25 },
          futureKey: { keep: true },
        },
        null,
        2,
      ) + "\n",
    );
    writeProjectConfig({ org: "new" }, { dir: root });
    const parsed = JSON.parse(read());
    expect(parsed.org).toBe("new"); // patched
    expect(parsed.upload.minCost).toBe(25); // preserved managed value
    expect(parsed.futureKey).toEqual({ keep: true }); // preserved unknown key
  });

  it("is a byte-stable no-op on a second identical write", () => {
    const first = writeProjectConfig({ org: "acme", upload: { minCost: 25 } }, { dir: root });
    expect(first.changed).toBe(true);
    const before = read();
    const second = writeProjectConfig({ org: "acme", upload: { minCost: 25 } }, { dir: root });
    expect(second.changed).toBe(false);
    expect(read()).toBe(before);
  });

  it("writes upload.auto:true and omits it when false (default)", () => {
    writeProjectConfig({ org: "acme", upload: { auto: true } }, { dir: root });
    expect(JSON.parse(read()).upload.auto).toBe(true);
    // false is the default — omitted
    writeProjectConfig({ org: "acme", upload: { auto: false } }, { dir: root });
    expect(JSON.parse(read()).upload?.auto).toBeUndefined();
  });

  it("writes upload.enabled:false and omits it when true (default)", () => {
    writeProjectConfig({ org: "acme", upload: { enabled: false } }, { dir: root });
    expect(JSON.parse(read()).upload.enabled).toBe(false);
    // true is the default — omitted
    writeProjectConfig({ org: "acme", upload: { enabled: true } }, { dir: root });
    expect(JSON.parse(read()).upload?.enabled).toBeUndefined();
  });

  it("writes snapshot.enabled:false and omits it when true (default)", () => {
    writeProjectConfig({ org: "acme", snapshot: { enabled: false } }, { dir: root });
    const parsed = JSON.parse(read());
    expect(parsed.snapshot.enabled).toBe(false);
    // true is the default — omitted, and the whole snapshot block is gone
    writeProjectConfig({ org: "acme", snapshot: { enabled: true } }, { dir: root });
    expect(JSON.parse(read()).snapshot).toBeUndefined();
  });

  it("upload block is omitted entirely when all values equal their defaults", () => {
    writeProjectConfig(
      {
        org: "acme",
        upload: {
          enabled: true,
          auto: false,
          minCost: 10,
          snapshot: true,
          concurrency: 4,
          linkPrs: false,
        },
      },
      { dir: root },
    );
    expect(JSON.parse(read()).upload).toBeUndefined();
  });

  it("merges snapshot block over an existing one without clobbering other upload keys", () => {
    writeProjectConfig(
      { org: "acme", upload: { minCost: 25 }, snapshot: { enabled: false } },
      { dir: root },
    );
    writeProjectConfig({ snapshot: { enabled: true } }, { dir: root });
    const parsed = JSON.parse(read());
    expect(parsed.upload.minCost).toBe(25); // preserved
    expect(parsed.snapshot).toBeUndefined(); // enabled:true → omitted
  });
});

describe("findProjectConfigDir", () => {
  let root: string;
  const savedConfigEnv = process.env["FRUGL_CONFIG"];

  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), "frugl-pcd-"));
    delete process.env["FRUGL_CONFIG"];
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
    if (savedConfigEnv === undefined) delete process.env["FRUGL_CONFIG"];
    else process.env["FRUGL_CONFIG"] = savedConfigEnv;
  });

  it("returns null when no .frugl.json exists", () => {
    expect(findProjectConfigDir(root, root)).toBeNull();
  });

  it("returns the directory containing the nearest .frugl.json", () => {
    write(root, JSON.stringify({ version: 1, org: "acme" }));
    expect(findProjectConfigDir(root, root)).toBe(root);
  });

  it("resolves from a nested subdirectory up to the config", () => {
    write(root, JSON.stringify({ version: 1, org: "acme" }));
    const deep = path.join(root, "src", "components");
    mkdirSync(deep, { recursive: true });
    expect(findProjectConfigDir(deep, root)).toBe(root);
  });

  it("prefers the nearest .frugl.json when nested configs exist", () => {
    write(root, JSON.stringify({ version: 1, org: "outer" }));
    const inner = path.join(root, "packages", "core");
    write(inner, JSON.stringify({ version: 1, org: "inner" }));
    expect(findProjectConfigDir(inner, root)).toBe(inner);
  });

  it("uses FRUGL_CONFIG override when set", () => {
    const other = mkdtempSync(path.join(tmpdir(), "frugl-pcd-alt-"));
    try {
      const explicit = path.join(other, "custom.json");
      writeFileSync(explicit, JSON.stringify({ version: 1, org: "override" }), "utf8");
      process.env["FRUGL_CONFIG"] = explicit;
      expect(findProjectConfigDir(root, root)).toBe(other);
    } finally {
      rmSync(other, { recursive: true, force: true });
    }
  });
});
