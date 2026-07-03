import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Temporal } from "temporal-polyfill";
import { nowIso } from "./time.js";

// This suite drives the interactive (TTY, default-mode) pending-auth-failure
// warning, the describeAgo formatting, and the defensive getPendingAuthFailure
// catch path — all of which the precedence suite (which stubs config to
// "nothing pending" on a non-TTY) never reaches.

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

// Per-test control over the config read; can be made to throw to drive the
// defensive catch branch.
let pendingImpl: () => { endpoint: string; at: string } | undefined;
vi.mock("./config.js", () => ({
  getPendingAuthFailure: () => pendingImpl(),
}));

// `buildCommandContext` reads `loadProjectPin()` with no cwd override, so
// without this it would ambiently pick up whatever `.frugl.json` sits above the
// real process cwd (e.g. this repo's own root) and win endpoint precedence over
// the env-set ENDPOINT these tests assert against. Pin-precedence itself is
// covered deliberately in command-context.test.ts; this suite just needs it
// out of the way.
vi.mock("../cloud/project-pin.js", () => ({
  loadProjectPin: () => undefined,
}));

const { buildCommandContext } = await import("./command-context.js");

const ENDPOINT = "https://env.example.com";

// A millisecond-ISO timestamp `ms` in the past — the Temporal replacement for
// `new Date(Date.now() - ms).toISOString()`.
const isoAgo = (ms: number): string =>
  Temporal.Now.instant().subtract({ milliseconds: ms }).toString({ smallestUnit: "millisecond" });

let stderr: string;
let originalTTY: boolean | undefined;

beforeEach(() => {
  stderr = "";
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
    pendingImpl = () => ({ endpoint: ENDPOINT, at: isoAgo(90_000) });
    await buildCommandContext({}, { auth: "optional" });
    expect(stderr).toContain("Your last automatic upload failed");
    expect(stderr).toContain("frugl login");
  });

  it("stays silent when the pending failure is for a different endpoint", async () => {
    pendingImpl = () => ({ endpoint: "https://other.example.com", at: nowIso() });
    await buildCommandContext({}, { auth: "optional" });
    expect(stderr).toBe("");
  });

  it("stays silent for a 'none' auth command even with a pending failure", async () => {
    pendingImpl = () => ({ endpoint: ENDPOINT, at: nowIso() });
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
    pendingImpl = () => ({ endpoint: ENDPOINT, at: nowIso() });
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
    expect(await warnWith(isoAgo(5_000))).toContain("just now");
  });

  it('"N min ago" for minutes', async () => {
    expect(await warnWith(isoAgo(30 * 60_000))).toContain("min ago");
  });

  it('"N hr ago" for hours', async () => {
    expect(await warnWith(isoAgo(5 * 3_600_000))).toContain("hr ago");
  });

  it('singular "1 day ago" for ~one day', async () => {
    expect(await warnWith(isoAgo(25 * 3_600_000))).toContain("1 day ago");
  });

  it('plural "N days ago" for multiple days', async () => {
    expect(await warnWith(isoAgo(3 * 86_400_000))).toContain("days ago");
  });

  it('"recently" for an unparseable timestamp', async () => {
    expect(await warnWith("not-a-date")).toContain("recently");
  });
});
