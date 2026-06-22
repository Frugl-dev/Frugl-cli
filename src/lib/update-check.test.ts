import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// In-memory stand-in for the on-disk Conf cache. A module-level store keeps
// state across the fresh `new Conf()` that checkForUpdate creates per call,
// mirroring how the real Conf persists to disk between invocations.
let store: Record<string, unknown> = {};
vi.mock("conf", () => ({
  default: class {
    get(key: string): unknown {
      return key in store ? store[key] : null;
    }
    set(key: string, value: unknown): void {
      store[key] = value;
    }
  },
}));

import { checkForUpdate } from "./update-check.js";

const DAY_MS = 24 * 60 * 60 * 1000;

function mockFetch(impl: () => Promise<Response> | Response): void {
  vi.stubGlobal("fetch", vi.fn(impl));
}

function jsonResponse(body: unknown, ok = true): Response {
  return {
    ok,
    json: async () => body,
  } as unknown as Response;
}

describe("checkForUpdate", () => {
  beforeEach(() => {
    store = {};
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("returns the latest version from a fresh registry fetch when it is newer", async () => {
    mockFetch(() => jsonResponse({ version: "2.0.0" }));
    const result = await checkForUpdate("1.0.0");
    expect(result).toBe("2.0.0");
    // The result is cached for next time.
    expect((store.data as { latestVersion: string }).latestVersion).toBe("2.0.0");
  });

  it("returns null when the latest version is not newer", async () => {
    mockFetch(() => jsonResponse({ version: "1.0.0" }));
    expect(await checkForUpdate("1.0.0")).toBeNull();
    expect(await checkForUpdate("2.0.0")).toBeNull();
  });

  it("uses a fresh cache without fetching", async () => {
    store.data = { checkedAt: Date.now(), latestVersion: "3.0.0" };
    const fetchSpy = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", fetchSpy);

    expect(await checkForUpdate("1.0.0")).toBe("3.0.0");
    expect(await checkForUpdate("3.0.0")).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("refetches when the cache is stale", async () => {
    store.data = { checkedAt: Date.now() - DAY_MS - 1, latestVersion: "1.0.0" };
    mockFetch(() => jsonResponse({ version: "4.0.0" }));
    expect(await checkForUpdate("1.0.0")).toBe("4.0.0");
  });

  it("returns null on a non-ok response", async () => {
    mockFetch(() => jsonResponse({ version: "9.9.9" }, false));
    expect(await checkForUpdate("1.0.0")).toBeNull();
  });

  it("returns null when the registry payload has no valid version", async () => {
    mockFetch(() => jsonResponse({}));
    expect(await checkForUpdate("1.0.0")).toBeNull();

    mockFetch(() => jsonResponse({ version: "not-a-version" }));
    expect(await checkForUpdate("1.0.0")).toBeNull();
  });

  it("returns null (silently) when fetch throws", async () => {
    mockFetch(() => {
      throw new Error("network down");
    });
    expect(await checkForUpdate("1.0.0")).toBeNull();
  });
});
