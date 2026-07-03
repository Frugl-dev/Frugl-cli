import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Temporal } from "temporal-polyfill";
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
  getSavedEndpoint,
  setSavedEndpoint,
  clearSavedEndpoint,
  getProfile,
  recordProfileIdentity,
  recordProfileOrg,
  clearProfile,
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
    expect(() => Temporal.Instant.from(pending?.at ?? "")).not.toThrow();
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

describe("frugl-config (endpoint)", () => {
  const LOCAL = "http://localhost:4321";
  const PROD = "https://app.frugl.dev";

  it("is undefined on a fresh store", () => {
    expect(getSavedEndpoint({ cwd: dir })).toBeUndefined();
  });

  it("round-trips set/get", () => {
    setSavedEndpoint(LOCAL, { cwd: dir });
    expect(getSavedEndpoint({ cwd: dir })).toBe(LOCAL);
    setSavedEndpoint(PROD, { cwd: dir });
    expect(getSavedEndpoint({ cwd: dir })).toBe(PROD);
  });

  it("clears the endpoint when it matches", () => {
    setSavedEndpoint(LOCAL, { cwd: dir });
    clearSavedEndpoint(LOCAL, { cwd: dir });
    expect(getSavedEndpoint({ cwd: dir })).toBeUndefined();
  });

  it("does NOT clear an endpoint saved for a different stack", () => {
    setSavedEndpoint(LOCAL, { cwd: dir });
    clearSavedEndpoint(PROD, { cwd: dir });
    expect(getSavedEndpoint({ cwd: dir })).toBe(LOCAL);
  });

  it("co-exists with other preferences without clobbering them", () => {
    setLinkPrs(true, { cwd: dir });
    setLastLoginMethod("github", { cwd: dir });
    setSavedEndpoint(LOCAL, { cwd: dir });
    expect(getLinkPrs({ cwd: dir })).toBe(true);
    expect(getLastLoginMethod({ cwd: dir })).toBe("github");
    clearSavedEndpoint(LOCAL, { cwd: dir });
    expect(getLinkPrs({ cwd: dir })).toBe(true);
    expect(getLastLoginMethod({ cwd: dir })).toBe("github");
    expect(getSavedEndpoint({ cwd: dir })).toBeUndefined();
  });

  it("ignores a malformed stored endpoint, falling back to defaults", () => {
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      path.join(dir, "frugl-config.json"),
      JSON.stringify({ data: { schemaVersion: 1, linkPrs: false, endpoint: "not-a-url" } }),
    );
    expect(() => getSavedEndpoint({ cwd: dir })).not.toThrow();
    expect(getSavedEndpoint({ cwd: dir })).toBeUndefined();
  });

  it("stays out of the key set until explicitly saved", () => {
    expect(Object.keys(readConfig({ cwd: dir })).toSorted()).toEqual(["linkPrs", "schemaVersion"]);
  });
});

describe("frugl-config (profile cache)", () => {
  const A = "https://a.frugl.dev";
  const B = "https://b.frugl.dev";
  const identityA = {
    endpoint: A,
    email: "a@x.com",
    userId: "u-a",
    loggedInAt: "2026-01-01T00:00:00.000Z",
  };

  it("returns undefined on a fresh store", () => {
    expect(getProfile(A, { cwd: dir })).toBeUndefined();
  });

  it("round-trips identity and is endpoint-scoped", () => {
    recordProfileIdentity(identityA, { cwd: dir });
    const p = getProfile(A, { cwd: dir });
    expect(p?.email).toBe("a@x.com");
    expect(p?.userId).toBe("u-a");
    expect(p?.loggedInAt).toBe("2026-01-01T00:00:00.000Z");
    expect(p?.org).toBeUndefined();
    expect(p?.updatedAt).toBeTruthy();
    // Only one profile is stored; a different endpoint sees nothing.
    expect(getProfile(B, { cwd: dir })).toBeUndefined();
  });

  it("records and clears the org", () => {
    recordProfileIdentity(identityA, { cwd: dir });
    recordProfileOrg(A, { slug: "acme", name: "Acme", role: "owner" }, { cwd: dir });
    expect(getProfile(A, { cwd: dir })?.org).toEqual({ slug: "acme", name: "Acme", role: "owner" });
    recordProfileOrg(A, null, { cwd: dir });
    expect(getProfile(A, { cwd: dir })?.org).toBeUndefined();
  });

  it("recordProfileOrg is a no-op without a matching profile", () => {
    // No identity yet.
    recordProfileOrg(A, { slug: "acme", name: "Acme", role: "owner" }, { cwd: dir });
    expect(getProfile(A, { cwd: dir })).toBeUndefined();
    // Identity for A, but org recorded against B — ignored.
    recordProfileIdentity(identityA, { cwd: dir });
    recordProfileOrg(B, { slug: "other", name: "Other", role: "member" }, { cwd: dir });
    expect(getProfile(A, { cwd: dir })?.org).toBeUndefined();
  });

  it("preserves the org across a re-login by the same user, drops it when the user changes", () => {
    recordProfileIdentity(identityA, { cwd: dir });
    recordProfileOrg(A, { slug: "acme", name: "Acme", role: "owner" }, { cwd: dir });
    // Same user re-logs in (offline org lookup would fail) — org is preserved.
    recordProfileIdentity(identityA, { cwd: dir });
    expect(getProfile(A, { cwd: dir })?.org).toEqual({ slug: "acme", name: "Acme", role: "owner" });
    // A different user on the same endpoint — the stale org is dropped.
    recordProfileIdentity({ endpoint: A, email: "c@x.com", userId: "u-c" }, { cwd: dir });
    expect(getProfile(A, { cwd: dir })?.org).toBeUndefined();
    expect(getProfile(A, { cwd: dir })?.email).toBe("c@x.com");
  });

  it("clearProfile is endpoint-scoped", () => {
    recordProfileIdentity(identityA, { cwd: dir });
    clearProfile(B, { cwd: dir }); // wrong endpoint — no-op
    expect(getProfile(A, { cwd: dir })?.email).toBe("a@x.com");
    clearProfile(A, { cwd: dir });
    expect(getProfile(A, { cwd: dir })).toBeUndefined();
  });
});
