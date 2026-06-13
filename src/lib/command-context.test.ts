import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Capture CloudClient construction options so we can assert token presence and
// the endpointExplicit rule without reaching into private fields.
interface CapturedClientOpts {
  endpointUrl: string;
  cliVersion: string;
  token?: string | undefined;
  endpointExplicit?: boolean;
}
const clientConstructions: CapturedClientOpts[] = [];

vi.mock("../cloud/client.js", () => ({
  CloudClient: class {
    readonly opts: CapturedClientOpts;
    constructor(opts: CapturedClientOpts) {
      this.opts = opts;
      clientConstructions.push(opts);
    }
  },
  CloudHttpError: class CloudHttpError extends Error {
    readonly status: number;
    readonly body: unknown;
    constructor(status: number, body: unknown, message: string) {
      super(message);
      this.status = status;
      this.body = body;
      this.name = "CloudHttpError";
    }
  },
}));

const loadAuthSession = vi.fn<(endpointUrl: string) => Promise<unknown>>();
const requireAuthSession = vi.fn<(endpointUrl: string) => Promise<unknown>>();
vi.mock("../auth/session.js", () => ({
  loadAuthSession: (url: string) => loadAuthSession(url),
  requireAuthSession: (url: string) => requireAuthSession(url),
}));

vi.mock("./cli-version.js", () => ({ getCliVersion: () => "9.9.9" }));

// Import after mocks are registered.
const { buildCommandContext } = await import("./command-context.js");
const { AuthError, UsageError } = await import("./errors.js");

const SESSION = {
  email: "a@b.test",
  userId: "u1",
  token: "tok-123",
  endpointUrl: "https://api.frugl.app",
  loggedInAt: "2026-01-01T00:00:00.000Z",
};

beforeEach(() => {
  clientConstructions.length = 0;
  loadAuthSession.mockReset();
  requireAuthSession.mockReset();
  delete process.env["FRUGL_ENDPOINT"];
});

afterEach(() => {
  delete process.env["FRUGL_ENDPOINT"];
});

describe("buildCommandContext — endpoint precedence", () => {
  it("flag wins over env and default; endpointExplicit true", async () => {
    process.env["FRUGL_ENDPOINT"] = "https://env.example.com";
    const ctx = await buildCommandContext(
      { endpoint: "https://flag.example.com" },
      { auth: "none" },
    );
    expect(ctx.endpoint.url).toBe("https://flag.example.com");
    expect(ctx.endpoint.resolvedFrom).toBe("flag");
    expect(clientConstructions[0]?.endpointExplicit).toBe(true);
  });

  it("FRUGL_ENDPOINT env wins over default; endpointExplicit true", async () => {
    process.env["FRUGL_ENDPOINT"] = "https://env.example.com";
    const ctx = await buildCommandContext({}, { auth: "none" });
    expect(ctx.endpoint.url).toBe("https://env.example.com");
    expect(ctx.endpoint.resolvedFrom).toBe("env");
    expect(clientConstructions[0]?.endpointExplicit).toBe(true);
  });

  it("falls back to the default; endpointExplicit false", async () => {
    const ctx = await buildCommandContext({}, { auth: "none" });
    expect(ctx.endpoint.url).toBe("https://app.frugl.dev");
    expect(ctx.endpoint.resolvedFrom).toBe("default");
    expect(clientConstructions[0]?.endpointExplicit).toBe(false);
  });

  it("surfaces a UsageError (exit 2) for an invalid endpoint", async () => {
    await expect(
      buildCommandContext({ endpoint: "not a url" }, { auth: "none" }),
    ).rejects.toBeInstanceOf(UsageError);
  });
});

describe("buildCommandContext — token presence per AuthMode", () => {
  it('"none": no session loaded, token-less client', async () => {
    const ctx = await buildCommandContext({}, { auth: "none" });
    expect(ctx.session).toBeNull();
    expect(loadAuthSession).not.toHaveBeenCalled();
    expect(requireAuthSession).not.toHaveBeenCalled();
    expect(clientConstructions[0]?.token).toBeUndefined();
  });

  it('"optional" with a session: client carries the token', async () => {
    loadAuthSession.mockResolvedValue(SESSION);
    const ctx = await buildCommandContext({}, { auth: "optional" });
    expect(ctx.session).toEqual(SESSION);
    expect(clientConstructions[0]?.token).toBe("tok-123");
  });

  it('"optional" with no session: returns null without throwing, token-less', async () => {
    loadAuthSession.mockResolvedValue(null);
    const ctx = await buildCommandContext({}, { auth: "optional" });
    expect(ctx.session).toBeNull();
    expect(clientConstructions[0]?.token).toBeUndefined();
  });

  it('"require" with a session: client carries the token', async () => {
    requireAuthSession.mockResolvedValue(SESSION);
    const ctx = await buildCommandContext({}, { auth: "require" });
    expect(ctx.session).toEqual(SESSION);
    expect(clientConstructions[0]?.token).toBe("tok-123");
  });

  it('"require" with no session: throws AuthError (exit 10)', async () => {
    requireAuthSession.mockRejectedValue(new AuthError("Not logged in."));
    await expect(buildCommandContext({}, { auth: "require" })).rejects.toBeInstanceOf(AuthError);
  });
});

describe("buildCommandContext — mode", () => {
  it("resolves json mode from the --format flag", async () => {
    const ctx = await buildCommandContext({ format: "json" }, { auth: "none" });
    expect(ctx.mode).toBe("json");
  });

  it("resolves minimal mode from the --format flag", async () => {
    const ctx = await buildCommandContext({ format: "minimal" }, { auth: "none" });
    expect(ctx.mode).toBe("minimal");
  });

  it("defaults to the default format", async () => {
    const ctx = await buildCommandContext({}, { auth: "none" });
    expect(ctx.mode).toBe("default");
  });
});
