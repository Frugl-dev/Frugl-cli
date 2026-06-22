import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { isCi, resolveDebug, resolveOutputMode } from "./output-mode.js";
import { isPlainOutput, setPlainOutput } from "./theme.js";

const CI_KEYS = ["CI", "GITHUB_ACTIONS", "GITLAB_CI", "CIRCLECI", "BUILDKITE", "TF_BUILD"] as const;

describe("isCi", () => {
  it("treats a truthy CI value as CI", () => {
    expect(isCi({ CI: "1" })).toBe(true);
    expect(isCi({ CI: "true" })).toBe(true);
    expect(isCi({ CI: "anything" })).toBe(true);
  });

  it("treats empty / 0 / false CI values as not CI", () => {
    expect(isCi({ CI: "" })).toBe(false);
    expect(isCi({ CI: "0" })).toBe(false);
    expect(isCi({ CI: "false" })).toBe(false);
  });

  it("detects providers that do not set CI", () => {
    expect(isCi({ GITHUB_ACTIONS: "true" })).toBe(true);
    expect(isCi({ GITLAB_CI: "true" })).toBe(true);
    expect(isCi({ CIRCLECI: "true" })).toBe(true);
    expect(isCi({ BUILDKITE: "true" })).toBe(true);
    expect(isCi({ TF_BUILD: "True" })).toBe(true);
  });

  it("returns false for a clean environment", () => {
    expect(isCi({})).toBe(false);
  });
});

describe("resolveOutputMode", () => {
  // Snapshot and restore the CI markers + plain state that test-setup strips, so
  // these cases can drive the auto-detection branch deterministically.
  let savedEnv: Record<string, string | undefined>;

  beforeEach(() => {
    savedEnv = {};
    for (const key of CI_KEYS) {
      savedEnv[key] = process.env[key];
      delete process.env[key];
    }
    setPlainOutput(false);
  });

  afterEach(() => {
    for (const key of CI_KEYS) {
      if (savedEnv[key] === undefined) delete process.env[key];
      else process.env[key] = savedEnv[key];
    }
    setPlainOutput(false);
  });

  it("returns an explicit format verbatim", () => {
    expect(resolveOutputMode({ format: "json" })).toBe("json");
    expect(resolveOutputMode({ format: "default" })).toBe("default");
    expect(resolveOutputMode({ format: "minimal" })).toBe("minimal");
  });

  it("falls back to default when no format and not CI", () => {
    expect(resolveOutputMode({})).toBe("default");
    expect(resolveOutputMode({ format: undefined })).toBe("default");
  });

  it("falls back to minimal when no format and CI is detected", () => {
    process.env.CI = "1";
    expect(resolveOutputMode({})).toBe("minimal");
  });

  it("forces plain output only for minimal", () => {
    resolveOutputMode({ format: "minimal" });
    expect(isPlainOutput()).toBe(true);

    resolveOutputMode({ format: "default" });
    expect(isPlainOutput()).toBe(false);

    resolveOutputMode({ format: "json" });
    expect(isPlainOutput()).toBe(false);
  });

  it("does not treat an unknown format string as a real mode", () => {
    // oclif validates the flag, but resolveOutputMode itself should fall back
    // rather than pass an arbitrary string through.
    expect(resolveOutputMode({ format: "bogus" })).toBe("default");
  });
});

describe("resolveDebug", () => {
  const saved = process.env.FRUGL_DEBUG;
  afterEach(() => {
    if (saved === undefined) delete process.env.FRUGL_DEBUG;
    else process.env.FRUGL_DEBUG = saved;
  });

  it("is true for 1 or true", () => {
    process.env.FRUGL_DEBUG = "1";
    expect(resolveDebug()).toBe(true);
    process.env.FRUGL_DEBUG = "true";
    expect(resolveDebug()).toBe(true);
  });

  it("is false otherwise", () => {
    delete process.env.FRUGL_DEBUG;
    expect(resolveDebug()).toBe(false);
    process.env.FRUGL_DEBUG = "0";
    expect(resolveDebug()).toBe(false);
    process.env.FRUGL_DEBUG = "yes";
    expect(resolveDebug()).toBe(false);
  });
});
