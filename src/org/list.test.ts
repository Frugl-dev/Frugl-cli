import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { OrgContext, OrgRuntime } from "./runtime.js";
import type { CloudClient } from "../cloud/client.js";
import type { AuthSession } from "../auth/session.js";

// runOrgList imports authedClient + fetchOrgContext directly from ./runtime.js
// (no DI), so we replace that module with injectable fakes. The render layer
// stays real, so we assert on actual table / no-org / JSON output.
const authedClientMock = vi.fn<(endpoint: string | undefined) => Promise<OrgRuntime>>();
const fetchOrgContextMock = vi.fn<(client: CloudClient) => Promise<OrgContext>>();

vi.mock("./runtime.js", () => ({
  authedClient: (endpoint: string | undefined) => authedClientMock(endpoint),
  fetchOrgContext: (client: CloudClient) => fetchOrgContextMock(client),
}));

const { runOrgList } = await import("./list.js");

const ANSI_RE = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g");
const plain = (s: string): string => s.replace(ANSI_RE, "");

const fakeClient = {} as CloudClient;

function fakeRuntime(email = "user@frugl.test"): OrgRuntime {
  return {
    client: fakeClient,
    session: { email } as AuthSession,
    endpoint: { url: "https://test", resolvedFrom: "default" } as OrgRuntime["endpoint"],
  };
}

let stdout: string;
let exitCode: number | undefined;

// Trap process.exit (runOrgList returns `never` via process.exit). Throw a
// sentinel so the awaited call unwinds and the test can read the captured code.
function runToExit(flags: Parameters<typeof runOrgList>[0]): Promise<void> {
  return runOrgList(flags).then(
    () => undefined,
    (e: unknown) => {
      if (e instanceof Error && e.message.startsWith("__exit__:")) return;
      throw e;
    },
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  stdout = "";
  exitCode = undefined;
  vi.spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array) => {
    stdout += String(chunk);
    return true;
  });
  vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
    exitCode = code;
    throw new Error(`__exit__:${code}`);
  }) as never);
  authedClientMock.mockResolvedValue(fakeRuntime());
});

afterEach(() => vi.restoreAllMocks());

describe("runOrgList — text/default mode", () => {
  it("renders a one-row table with the active dot for a member org", async () => {
    fetchOrgContextMock.mockResolvedValue({
      kind: "member",
      slug: "acme",
      name: "Acme",
      role: "owner",
      memberCount: 3,
    });

    await runToExit({});

    const out = plain(stdout);
    expect(out).toContain("SLUG");
    expect(out).toContain("acme");
    expect(out).toContain("owner");
    // member_count surfaces in the MEMBERS column.
    expect(out).toContain("3");
    expect(exitCode).toBe(0);
  });

  it("renders an em-dash for MEMBERS when memberCount is absent", async () => {
    fetchOrgContextMock.mockResolvedValue({
      kind: "member",
      slug: "acme",
      name: "Acme",
      role: "owner",
    });

    await runToExit({});

    expect(plain(stdout)).toContain("—");
    expect(exitCode).toBe(0);
  });

  it("renders the no-org guidance (incl. signed-in email) at exit 0, not a failure", async () => {
    fetchOrgContextMock.mockResolvedValue({ kind: "none" });
    authedClientMock.mockResolvedValue(fakeRuntime("nobody@frugl.test"));

    await runToExit({});

    const out = plain(stdout);
    expect(out).toContain("You're not in any org yet.");
    expect(out).toContain("frugl org create");
    expect(out).toContain("frugl org join");
    expect(out).toContain("nobody@frugl.test");
    expect(exitCode).toBe(0);
  });

  it("threads the endpoint flag into authedClient", async () => {
    fetchOrgContextMock.mockResolvedValue({ kind: "none" });

    await runToExit({ endpoint: "https://custom" });

    expect(authedClientMock).toHaveBeenCalledWith("https://custom");
    // The resolved client is passed straight to fetchOrgContext.
    expect(fetchOrgContextMock).toHaveBeenCalledWith(fakeClient);
  });
});

describe("runOrgList — JSON mode", () => {
  it("emits a one-element organizations array with active slug for a member", async () => {
    fetchOrgContextMock.mockResolvedValue({
      kind: "member",
      slug: "acme",
      name: "Acme",
      role: "owner",
      memberCount: 5,
    });

    await runToExit({ format: "json" });

    expect(JSON.parse(stdout)).toEqual({
      command: "org",
      ok: true,
      activeSlug: "acme",
      organizations: [{ slug: "acme", name: "Acme", role: "owner", member_count: 5, active: true }],
    });
    expect(exitCode).toBe(0);
  });

  it("omits member_count from the JSON row when absent", async () => {
    fetchOrgContextMock.mockResolvedValue({
      kind: "member",
      slug: "acme",
      name: "Acme",
      role: "member",
    });

    await runToExit({ format: "json" });

    const parsed = JSON.parse(stdout) as { organizations: Array<Record<string, unknown>> };
    expect(parsed.organizations[0]).not.toHaveProperty("member_count");
    expect(parsed.organizations[0]).toEqual({
      slug: "acme",
      name: "Acme",
      role: "member",
      active: true,
    });
  });

  it("emits an empty array and null activeSlug when in no org", async () => {
    fetchOrgContextMock.mockResolvedValue({ kind: "none" });

    await runToExit({ format: "json" });

    expect(JSON.parse(stdout)).toEqual({
      command: "org",
      ok: true,
      activeSlug: null,
      organizations: [],
    });
    expect(exitCode).toBe(0);
  });
});

describe("runOrgList — errors", () => {
  it("routes an auth failure through handleCommandError (exit 10)", async () => {
    const { AuthError } = await import("../lib/errors.js");
    authedClientMock.mockRejectedValue(new AuthError("Not logged in."));

    await runToExit({});

    // EXIT.AUTH_FAILURE
    expect(exitCode).toBe(10);
    expect(fetchOrgContextMock).not.toHaveBeenCalled();
  });

  it("routes a CloudHttpError from fetch through handleCommandError (exit 1)", async () => {
    const { CloudHttpError } = await import("../cloud/client.js");
    fetchOrgContextMock.mockRejectedValue(new CloudHttpError(500, {}, "boom"));

    await runToExit({});

    // EXIT.GENERIC_FAILURE
    expect(exitCode).toBe(1);
  });

  it("re-throws an arbitrary (non-Frugl) error rather than swallowing it", async () => {
    const arbitrary = new Error("totally unexpected");
    fetchOrgContextMock.mockRejectedValue(arbitrary);

    await expect(runOrgList({})).rejects.toBe(arbitrary);
    expect(exitCode).toBeUndefined();
  });
});
