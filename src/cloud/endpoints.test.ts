import { describe, expect, it } from "vitest";
import {
  DEFAULT_ENDPOINT,
  describeEndpointSource,
  resolveEndpoint,
  safeEndpoint,
} from "./endpoints.js";
import { UsageError } from "../lib/errors.js";

describe("resolveEndpoint — precedence flag ?? pin ?? env ?? default", () => {
  it("flag wins over env and default", () => {
    const r = resolveEndpoint({
      flag: "https://flag.example.com",
      env: "https://env.example.com",
    });
    expect(r.url).toBe("https://flag.example.com");
    expect(r.resolvedFrom).toBe("flag");
  });

  it("env wins over the default", () => {
    const r = resolveEndpoint({
      env: "https://env.example.com",
    });
    expect(r.url).toBe("https://env.example.com");
    expect(r.resolvedFrom).toBe("env");
  });

  it("falls back to the prod default when nothing is supplied", () => {
    const r = resolveEndpoint({});
    expect(r.url).toBe(DEFAULT_ENDPOINT);
    expect(r.resolvedFrom).toBe("default");
  });

  it("trailing slash is normalized away", () => {
    expect(resolveEndpoint({ env: "http://localhost:4321/" }).url).toBe("http://localhost:4321");
  });

  it("an explicit invalid flag still throws (loud failure on user input)", () => {
    expect(() => resolveEndpoint({ flag: "not a url" })).toThrow(UsageError);
  });

  it("there is no machine-global saved layer — nothing but the inputs decides", () => {
    // Regression guard for the removed "endpoint remembered from last login":
    // with no flag/pin/env, resolution MUST land on the public default, never on
    // ambient per-user state (which once sent fresh installs to localhost).
    expect(resolveEndpoint({}).url).toBe(DEFAULT_ENDPOINT);
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

describe("resolveEndpoint — a `.frugl.json` pin (the project's source of truth)", () => {
  const PIN = "https://frugl.internal";

  it("the pin overrides a stale env, and never falls back to the public default", () => {
    const r = resolveEndpoint({
      pinned: PIN,
      env: DEFAULT_ENDPOINT, // a forgotten FRUGL_ENDPOINT in a shell profile
    });
    expect(r.url).toBe(PIN);
    expect(r.resolvedFrom).toBe("pin");
  });

  it("the pin is used when nothing else is supplied (no fall-through to default)", () => {
    const r = resolveEndpoint({ pinned: PIN });
    expect(r.url).toBe(PIN);
    expect(r.resolvedFrom).toBe("pin");
  });

  it("a hand-typed --endpoint flag wins over the pin (the flag IS the escape hatch)", () => {
    const r = resolveEndpoint({ flag: "https://elsewhere.example.com", pinned: PIN });
    expect(r.url).toBe("https://elsewhere.example.com");
    expect(r.resolvedFrom).toBe("flag");
  });
});

describe("resolveEndpoint — a FRUGL_CONFIG_PATH config file (local-debug pointer)", () => {
  const CONFIG = "http://localhost:4321";
  const PIN = "https://frugl.internal";

  it("the config path outranks the cwd pin and a stale env", () => {
    const r = resolveEndpoint({ configPath: CONFIG, pinned: PIN, env: DEFAULT_ENDPOINT });
    expect(r.url).toBe(CONFIG);
    expect(r.resolvedFrom).toBe("config-path");
  });

  it("a hand-typed --endpoint flag still wins over the config path", () => {
    const r = resolveEndpoint({ flag: "https://elsewhere.example.com", configPath: CONFIG });
    expect(r.url).toBe("https://elsewhere.example.com");
    expect(r.resolvedFrom).toBe("flag");
  });
});

describe("describeEndpointSource — names the layer so errors aren't dead-ends", () => {
  it("covers every source", () => {
    expect(describeEndpointSource("flag")).toBe("set by --endpoint");
    expect(describeEndpointSource("config-path")).toBe("set by FRUGL_CONFIG_PATH");
    expect(describeEndpointSource("pin")).toBe("pinned by .frugl.json");
    expect(describeEndpointSource("env")).toBe("set by FRUGL_ENDPOINT");
    expect(describeEndpointSource("default")).toBe("the default endpoint");
  });
});
