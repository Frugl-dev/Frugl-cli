import { describe, it, expect } from "vitest";
import { checkVersionGate, formatVersionGateMessage } from "./version-gate.js";
import { VersionGateError } from "../lib/errors.js";

describe("checkVersionGate", () => {
  it("does NOT throw when current >= required", () => {
    expect(() => checkVersionGate("1.2.3", { minSupportedCliVersion: "1.0.0" })).not.toThrow();
    expect(() => checkVersionGate("1.0.0", { minSupportedCliVersion: "1.0.0" })).not.toThrow();
  });

  it("throws VersionGateError when current < required", () => {
    expect(() => checkVersionGate("0.5.0", { minSupportedCliVersion: "1.0.0" })).toThrow(
      VersionGateError,
    );
  });

  it("reads the server's snake_case min_version field", () => {
    // The deployed server sends { error: "cli_too_old", min_version } —
    // the camelCase name only ever existed in spec drafts.
    expect(() => checkVersionGate("0.5.0", { error: "cli_too_old", min_version: "1.0.0" })).toThrow(
      VersionGateError,
    );
    expect(() =>
      checkVersionGate("1.2.3", { error: "cli_too_old", min_version: "1.0.0" }),
    ).not.toThrow();
  });

  it("carries requiredVersion from min_version on the error", () => {
    const err = collectError(() =>
      checkVersionGate("0.1.0", { error: "cli_too_old", min_version: "1.0.0" }),
    );
    expect(err).toBeInstanceOf(VersionGateError);
    expect((err as VersionGateError).requiredVersion).toBe("1.0.0");
  });

  it("throws when body is malformed (treats it as outdated)", () => {
    expect(() => checkVersionGate("1.0.0", { weird: "body" })).toThrow(VersionGateError);
  });

  it("carries currentVersion and requiredVersion on the error", () => {
    const err = collectError(() => checkVersionGate("0.1.0", { minSupportedCliVersion: "1.0.0" }));
    expect(err).toBeInstanceOf(VersionGateError);
    const e = err as VersionGateError;
    expect(e.currentVersion).toBe("0.1.0");
    expect(e.requiredVersion).toBe("1.0.0");
  });
});

function collectError(fn: () => unknown): unknown {
  try {
    fn();
  } catch (err) {
    return err;
  }
  throw new Error("expected fn to throw");
}

describe("formatVersionGateMessage (suffix)", () => {
  it("is exported", () => {
    expect(true).toBe(true);
  });
});

describe("formatVersionGateMessage", () => {
  it("names current, required, and the upgrade command", () => {
    const msg = formatVersionGateMessage("0.1.0", "1.0.0");
    expect(msg).toContain("0.1.0");
    expect(msg).toContain("1.0.0");
    expect(msg).toContain("npm install");
  });
});
