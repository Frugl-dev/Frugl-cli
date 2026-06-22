import { describe, expect, it } from "vitest";
import { NAMESPACES, PATHS } from "./paths.js";

describe("NAMESPACES", () => {
  it("exposes the stable on-disk namespace identifiers", () => {
    expect(NAMESPACES).toEqual({
      resume: "frugl-resume-state",
      ledger: "frugl-ledger",
      config: "frugl-config",
    });
  });
});

describe("PATHS", () => {
  it("resolves a distinct, absolute data dir per namespace", () => {
    for (const dir of Object.values(PATHS)) {
      expect(typeof dir).toBe("string");
      expect(dir.length).toBeGreaterThan(0);
    }
    const dirs = Object.values(PATHS);
    expect(new Set(dirs).size).toBe(dirs.length);
  });

  it("derives each data dir from its namespace", () => {
    expect(PATHS.resumeStateDir).toContain(NAMESPACES.resume);
    expect(PATHS.ledgerStateDir).toContain(NAMESPACES.ledger);
    expect(PATHS.configStateDir).toContain(NAMESPACES.config);
  });
});
