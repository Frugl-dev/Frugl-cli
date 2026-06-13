import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  getLinkPrs,
  setLinkPrs,
  readConfig,
  getLastLoginMethod,
  setLastLoginMethod,
  getPendingAuthFailure,
  recordPendingAuthFailure,
  clearPendingAuthFailure,
} from "./config.js";

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

  it("stores only known preference keys (no repository data)", () => {
    setLinkPrs(true, { cwd: dir });
    expect(Object.keys(readConfig({ cwd: dir })).toSorted()).toEqual(["linkPrs", "schemaVersion"]);
  });
});

describe("frugl-config (lastLoginMethod)", () => {
  it("is undefined on a fresh store", () => {
    expect(getLastLoginMethod({ cwd: dir })).toBeUndefined();
  });

  it("round-trips set/get", () => {
    setLastLoginMethod("github", { cwd: dir });
    expect(getLastLoginMethod({ cwd: dir })).toBe("github");
    setLastLoginMethod("otp", { cwd: dir });
    expect(getLastLoginMethod({ cwd: dir })).toBe("otp");
  });

  it("co-exists with linkPrs without clobbering it", () => {
    setLinkPrs(true, { cwd: dir });
    setLastLoginMethod("google", { cwd: dir });
    expect(getLinkPrs({ cwd: dir })).toBe(true);
    expect(getLastLoginMethod({ cwd: dir })).toBe("google");
  });

  it("ignores an invalid stored method, falling back to defaults", () => {
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      path.join(dir, "frugl-config.json"),
      JSON.stringify({
        data: { schemaVersion: 1, linkPrs: false, lastLoginMethod: "carrier-pigeon" },
      }),
    );
    expect(() => getLastLoginMethod({ cwd: dir })).not.toThrow();
    expect(getLastLoginMethod({ cwd: dir })).toBeUndefined();
  });
});

describe("frugl-config (pendingAuthFailure)", () => {
  const ENDPOINT = "https://app.frugl.dev";

  it("is undefined on a fresh store", () => {
    expect(getPendingAuthFailure({ cwd: dir })).toBeUndefined();
  });

  it("records an endpoint with a timestamp, then reads it back", () => {
    recordPendingAuthFailure(ENDPOINT, { cwd: dir });
    const pending = getPendingAuthFailure({ cwd: dir });
    expect(pending?.endpoint).toBe(ENDPOINT);
    expect(() => new Date(pending?.at ?? "").toISOString()).not.toThrow();
  });

  it("clears the breadcrumb when the endpoint matches", () => {
    recordPendingAuthFailure(ENDPOINT, { cwd: dir });
    clearPendingAuthFailure(ENDPOINT, { cwd: dir });
    expect(getPendingAuthFailure({ cwd: dir })).toBeUndefined();
  });

  it("does NOT clear a breadcrumb recorded against a different endpoint", () => {
    recordPendingAuthFailure(ENDPOINT, { cwd: dir });
    clearPendingAuthFailure("https://staging.frugl.dev", { cwd: dir });
    expect(getPendingAuthFailure({ cwd: dir })?.endpoint).toBe(ENDPOINT);
  });

  it("co-exists with other preferences without clobbering them", () => {
    setLinkPrs(true, { cwd: dir });
    setLastLoginMethod("github", { cwd: dir });
    recordPendingAuthFailure(ENDPOINT, { cwd: dir });
    expect(getLinkPrs({ cwd: dir })).toBe(true);
    expect(getLastLoginMethod({ cwd: dir })).toBe("github");
    // Clearing the breadcrumb leaves the rest intact.
    clearPendingAuthFailure(ENDPOINT, { cwd: dir });
    expect(getLinkPrs({ cwd: dir })).toBe(true);
    expect(getLastLoginMethod({ cwd: dir })).toBe("github");
    expect(getPendingAuthFailure({ cwd: dir })).toBeUndefined();
  });

  it("ignores a malformed stored breadcrumb, falling back to defaults", () => {
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      path.join(dir, "frugl-config.json"),
      JSON.stringify({
        data: { schemaVersion: 1, linkPrs: false, pendingAuthFailure: { endpoint: "not-a-url" } },
      }),
    );
    expect(() => getPendingAuthFailure({ cwd: dir })).not.toThrow();
    expect(getPendingAuthFailure({ cwd: dir })).toBeUndefined();
  });
});
