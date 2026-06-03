import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { getLinkPrs, setLinkPrs, readConfig } from "./config.js";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "frugl-config-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("frugl-config (linkPrs)", () => {
  it("defaults to linkPrs:false on a fresh store", () => {
    expect(getLinkPrs({ cwd: dir })).toBe(false);
    expect(readConfig({ cwd: dir })).toEqual({ schemaVersion: 1, linkPrs: false });
  });

  it("round-trips set/get", () => {
    setLinkPrs(true, { cwd: dir });
    expect(getLinkPrs({ cwd: dir })).toBe(true);
    setLinkPrs(false, { cwd: dir });
    expect(getLinkPrs({ cwd: dir })).toBe(false);
  });

  it("treats a schema-version mismatch as defaults, not an error", () => {
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      path.join(dir, "frugl-config.json"),
      JSON.stringify({ data: { schemaVersion: 999, linkPrs: true } }),
    );
    // Unknown schema version → fall back to defaults (linkPrs:false), no throw.
    expect(() => getLinkPrs({ cwd: dir })).not.toThrow();
    expect(getLinkPrs({ cwd: dir })).toBe(false);
  });

  it("stores only the boolean preference (no repository data)", () => {
    setLinkPrs(true, { cwd: dir });
    expect(Object.keys(readConfig({ cwd: dir })).sort()).toEqual(["linkPrs", "schemaVersion"]);
  });
});
