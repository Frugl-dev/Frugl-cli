import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// This suite drives the interactive (TTY, default-mode) pending-auth-failure
// warning, the describeAgo formatting, and the defensive readSavedEndpoint /
// getPendingAuthFailure catch paths — all of which the precedence suite (which
// stubs config to "nothing pending" on a non-TTY) never reaches.

vi.mock("../cloud/client.js", () => ({
  CloudClient: class {
    readonly opts: unknown;
    constructor(opts: unknown) {
      this.opts = opts;
    }
  },
  CloudHttpError: class CloudHttpError extends Error {},
}));

vi.mock("../auth/session.js", () => ({
  loadAuthSession: () => Promise.resolve(null),
  requireAuthSession: () => Promise.resolve(null),
}));

vi.mock("./cli-version.js", () => ({ getCliVersion: () => "9.9.9" }));

// Per-test control over the two config reads. Both can be made to throw to drive
// the defensive catch branches.
let savedEndpointImpl: () => string | undefined;
let pendingImpl: () => { endpoint: string; at: string } | undefined;
vi.mock("./config.js", () => ({
  getSavedEndpoint: () => savedEndpointImpl(),
  getPendingAuthFailure: () => pendingImpl(),
}));

const { buildCommandContext } = await import("./command-context.js");

const ENDPOINT = "https://env.example.com";

let stderr: string;
let originalTTY: boolean | undefined;

beforeEach(() => {
  stderr = "";
  savedEndpointImpl = () => undefined;
  pendingImpl = () => undefined;
  process.env["FRUGL_ENDPOINT"] = ENDPOINT;
  originalTTY = process.stdout.isTTY;
  Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });
  vi.spyOn(process.stderr, "write").mockImplementation((chunk: string | Uint8Array) => {
    stderr += String(chunk);
    return true;
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env["FRUGL_ENDPOINT"];
  Object.defineProperty(process.stdout, "isTTY", { value: originalTTY, configurable: true });
});

describe("warnPendingAuthFailure — interactive, default mode", () => {
  it("warns on stderr when a pending failure matches the resolved endpoint", async () => {
    pendingImpl = () => ({ endpoint: ENDPOINT, at: new Date(Date.now() - 90_000).toISOString() });
    await buildCommandContext({}, { auth: "optional" });
    expect(stderr).toContain("Your last automatic upload failed");
    expect(stderr).toContain("frugl login");
  });

  it("stays silent when the pending failure is for a different endpoint", async () => {
    pendingImpl = () => ({ endpoint: "https://other.example.com", at: new Date().toISOString() });
    await buildCommandContext({}, { auth: "optional" });
    expect(stderr).toBe("");
  });

  it("stays silent for a 'none' auth command even with a pending failure", async () => {
    pendingImpl = () => ({ endpoint: ENDPOINT, at: new Date().toISOString() });
    await buildCommandContext({}, { auth: "none" });
    expect(stderr).toBe("");
  });

  it("does not throw when reading the pending breadcrumb fails", async () => {
    pendingImpl = () => {
      throw new Error("config glitch");
    };
    await expect(buildCommandContext({}, { auth: "optional" })).resolves.toBeDefined();
    expect(stderr).toBe("");
  });

  it("stays silent in json mode despite a TTY and a matching pending failure", async () => {
    pendingImpl = () => ({ endpoint: ENDPOINT, at: new Date().toISOString() });
    await buildCommandContext({ format: "json" }, { auth: "optional" });
    expect(stderr).toBe("");
  });
});

describe("describeAgo — coarse relative phrasing via the warning line", () => {
  async function warnWith(at: string): Promise<string> {
    pendingImpl = () => ({ endpoint: ENDPOINT, at });
    await buildCommandContext({}, { auth: "optional" });
    return stderr;
  }

  it('"just now" for a sub-minute failure', async () => {
    expect(await warnWith(new Date(Date.now() - 5_000).toISOString())).toContain("just now");
  });

  it('"N min ago" for minutes', async () => {
    expect(await warnWith(new Date(Date.now() - 30 * 60_000).toISOString())).toContain("min ago");
  });

  it('"N hr ago" for hours', async () => {
    expect(await warnWith(new Date(Date.now() - 5 * 3_600_000).toISOString())).toContain("hr ago");
  });

  it('singular "1 day ago" for ~one day', async () => {
    expect(await warnWith(new Date(Date.now() - 25 * 3_600_000).toISOString())).toContain(
      "1 day ago",
    );
  });

  it('plural "N days ago" for multiple days', async () => {
    expect(await warnWith(new Date(Date.now() - 3 * 86_400_000).toISOString())).toContain(
      "days ago",
    );
  });

  it('"recently" for an unparseable timestamp', async () => {
    expect(await warnWith("not-a-date")).toContain("recently");
  });
});

describe("readSavedEndpoint — defensive catch", () => {
  it("falls back to the default endpoint when the saved read throws", async () => {
    delete process.env["FRUGL_ENDPOINT"];
    savedEndpointImpl = () => {
      throw new Error("store glitch");
    };
    const ctx = await buildCommandContext({}, { auth: "none" });
    expect(ctx.endpoint.resolvedFrom).toBe("default");
  });
});
