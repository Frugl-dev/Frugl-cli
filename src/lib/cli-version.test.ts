import { describe, expect, it } from "vitest";
import { getCliVersion } from "./cli-version.js";

describe("getCliVersion", () => {
  it("reads a valid semver version from the package.json", () => {
    const version = getCliVersion();
    expect(version).toMatch(/^\d+\.\d+\.\d+/);
    expect(version).not.toBe("0.0.0");
  });

  it("caches the resolved version (stable across calls)", () => {
    expect(getCliVersion()).toBe(getCliVersion());
  });
});
