import { describe, expect, it } from "vitest";
import { DEFAULT_ENDPOINT, resolveEndpoint, safeEndpoint } from "./endpoints.js";
import { EndpointError, UsageError } from "../lib/errors.js";

describe("resolveEndpoint — precedence flag ?? env ?? saved ?? default", () => {
  it("flag wins over env, saved, and default", () => {
    const r = resolveEndpoint({
      flag: "https://flag.example.com",
      env: "https://env.example.com",
      saved: "http://localhost:4321",
    });
    expect(r.url).toBe("https://flag.example.com");
    expect(r.resolvedFrom).toBe("flag");
  });

  it("env wins over saved and default", () => {
    const r = resolveEndpoint({
      env: "https://env.example.com",
      saved: "http://localhost:4321",
    });
    expect(r.url).toBe("https://env.example.com");
    expect(r.resolvedFrom).toBe("env");
  });

  it("saved wins over the default when no flag/env is present", () => {
    const r = resolveEndpoint({ saved: "http://localhost:4321" });
    expect(r.url).toBe("http://localhost:4321");
    expect(r.resolvedFrom).toBe("saved");
  });

  it("falls back to the prod default when nothing is supplied", () => {
    const r = resolveEndpoint({});
    expect(r.url).toBe(DEFAULT_ENDPOINT);
    expect(r.resolvedFrom).toBe("default");
  });

  it("trailing slash is normalized away on the saved layer", () => {
    expect(resolveEndpoint({ saved: "http://localhost:4321/" }).url).toBe("http://localhost:4321");
  });

  it("an explicit invalid flag still throws (loud failure on user input)", () => {
    expect(() => resolveEndpoint({ flag: "not a url" })).toThrow(UsageError);
  });
});

describe("safeEndpoint — tolerant normalize for the persisted/untrusted layer", () => {
  it("returns the normalized URL for a valid endpoint", () => {
    expect(safeEndpoint("http://localhost:4321/")).toBe("http://localhost:4321");
    expect(safeEndpoint("https://app.frugl.dev")).toBe("https://app.frugl.dev");
  });

  it("returns undefined for undefined input", () => {
    expect(safeEndpoint(undefined)).toBeUndefined();
  });

  it("returns undefined for a malformed URL instead of throwing", () => {
    expect(safeEndpoint("not a url")).toBeUndefined();
  });

  it("returns undefined for a non-localhost http endpoint (https-only rule)", () => {
    // A corrupted/hand-edited config pointing at plain-http prod must NOT brick
    // every command — it degrades to the default rather than throwing.
    expect(safeEndpoint("http://evil.example.com")).toBeUndefined();
  });
});

describe("resolveEndpoint — a `.frugl.json` pin is fail-closed (self-host)", () => {
  const PIN = "https://frugl.internal";

  it("uses the pin over a stale saved/env, and never the public default", () => {
    const r = resolveEndpoint({
      saved: DEFAULT_ENDPOINT, // a stale 'logged into the public cloud' session
      pinned: PIN,
    });
    expect(r.url).toBe(PIN);
    expect(r.resolvedFrom).toBe("pin");
  });

  it("pins even when nothing else is supplied (no fall-through to default)", () => {
    const r = resolveEndpoint({ pinned: PIN });
    expect(r.url).toBe(PIN);
    expect(r.resolvedFrom).toBe("pin");
  });

  it("accepts an explicit --endpoint that AGREES with the pin", () => {
    const r = resolveEndpoint({ flag: `${PIN}/`, pinned: PIN });
    expect(r.url).toBe(PIN);
    expect(r.resolvedFrom).toBe("flag");
  });

  it("REFUSES a --endpoint that disagrees with the pin", () => {
    expect(() =>
      resolveEndpoint({
        flag: "https://elsewhere.example.com",
        pinned: PIN,
        pinPath: "/repo/.frugl.json",
      }),
    ).toThrow(EndpointError);
  });

  it("REFUSES a FRUGL_ENDPOINT env that disagrees with the pin", () => {
    expect(() => resolveEndpoint({ env: "https://elsewhere.example.com", pinned: PIN })).toThrow(
      EndpointError,
    );
  });

  it("--force-endpoint overrides a disagreeing pin (operator escape hatch)", () => {
    const r = resolveEndpoint({
      flag: "https://elsewhere.example.com",
      pinned: PIN,
      forceEndpoint: true,
    });
    expect(r.url).toBe("https://elsewhere.example.com");
    expect(r.resolvedFrom).toBe("flag");
  });

  it("throws on a malformed pin rather than degrading to the public default", () => {
    expect(() => resolveEndpoint({ pinned: "not a url" })).toThrow(UsageError);
  });
});
