import { describe, it, expect, afterEach } from "vitest";
import { CloudHttpError } from "../cloud/client.js";
import type { Endpoint } from "../cloud/endpoints.js";
import type { AuthSession } from "../auth/session.js";
import { UsageError } from "../lib/errors.js";
import { runAuthAndOrgSetup } from "./onboard.js";

// A network-free CloudClient stand-in: records setToken + serves canned
// responses keyed by "METHOD path" (mirrors org/setup.test.ts). The org flow is
// the only thing that calls `.call`; auth in these tests is supplied via a
// pre-existing session, so no AuthService network ever runs.
function makeFakeClient(responses: Record<string, unknown | Error>) {
  let token: string | null = null;
  const calls: Array<{ method: string; path: string }> = [];
  return {
    get token() {
      return token;
    },
    calls,
    setToken: (t: string) => {
      token = t;
    },
    async call({ method, path }: { method: string; path: string }) {
      calls.push({ method, path });
      const r = responses[`${method} ${path}`];
      if (r instanceof Error) throw r;
      return r;
    },
  };
}

const ENDPOINT: Endpoint = { url: "https://test", resolvedFrom: "flag" };

function session(): AuthSession {
  return {
    email: "tester@frugl.example",
    userId: "u1",
    token: "tok-123",
    endpointUrl: ENDPOINT.url,
    loggedInAt: new Date().toISOString(),
  };
}

const orgRequired = () => new CloudHttpError(409, { error: "org_required" }, "HTTP 409");

afterEach(() => {
  delete process.env["FRUGL_TOKEN"];
});

describe("runAuthAndOrgSetup", () => {
  it("reuses a saved session (no OTP) and creates an org via --org-name", async () => {
    const client = makeFakeClient({
      "GET /api/orgs/me": orgRequired(),
      "POST /api/orgs/create": { org: { id: "o1", name: "Acme", slug: "acme" } },
    });
    const result = await runAuthAndOrgSetup({
      endpoint: ENDPOINT,
      client: client as never,
      mode: "default",
      existingSession: session(),
      flags: { orgName: "Acme" },
      command: "init",
    });
    expect(result.session.email).toBe("tester@frugl.example");
    expect(result.orgResult.status).toBe("created");
    expect(result.orgResult.slug).toBe("acme");
    // The flow ran under the reused session's token.
    expect(client.token).toBe("tok-123");
  });

  it("joins an org via --invite-code", async () => {
    const client = makeFakeClient({
      "GET /api/orgs/me": orgRequired(),
      "POST /api/join": { org: { name: "Team", slug: "team" } },
    });
    const result = await runAuthAndOrgSetup({
      endpoint: ENDPOINT,
      client: client as never,
      mode: "default",
      existingSession: session(),
      flags: { inviteCode: "pop_inv_abc" },
      command: "init",
    });
    expect(result.orgResult.status).toBe("joined");
    expect(result.orgResult.slug).toBe("team");
  });

  it("returns already-setup when the user is already in an org", async () => {
    const client = makeFakeClient({
      "GET /api/orgs/me": {
        org: { id: "o1", name: "Acme", slug: "acme" },
        membership: { role: "owner" },
      },
    });
    const result = await runAuthAndOrgSetup({
      endpoint: ENDPOINT,
      client: client as never,
      mode: "default",
      existingSession: session(),
      flags: { orgName: "Whatever" },
      command: "init",
    });
    expect(result.orgResult.status).toBe("already-setup");
    expect(result.orgResult.slug).toBe("acme");
  });

  it("FR-005: --yes with no session and no FRUGL_TOKEN fails fast (UsageError)", async () => {
    const client = makeFakeClient({});
    await expect(
      runAuthAndOrgSetup({
        endpoint: ENDPOINT,
        client: client as never,
        mode: "default",
        existingSession: null,
        flags: { yes: true, orgName: "Acme" },
        command: "init",
      }),
    ).rejects.toThrow(UsageError);
  });

  it("--yes with no org flag returns the existing org when already a member", async () => {
    const client = makeFakeClient({
      "GET /api/orgs/me": {
        org: { id: "o1", name: "Acme", slug: "acme" },
        membership: { role: "owner" },
      },
    });
    const result = await runAuthAndOrgSetup({
      endpoint: ENDPOINT,
      client: client as never,
      mode: "default",
      existingSession: session(),
      flags: { yes: true },
      command: "init",
    });
    expect(result.orgResult.status).toBe("already-setup");
    expect(result.orgResult.slug).toBe("acme");
  });

  it("FR-005: --yes with a session, no org flag, and no org yet fails fast (UsageError)", async () => {
    const client = makeFakeClient({ "GET /api/orgs/me": orgRequired() });
    await expect(
      runAuthAndOrgSetup({
        endpoint: ENDPOINT,
        client: client as never,
        mode: "default",
        existingSession: session(),
        flags: { yes: true },
        command: "init",
      }),
    ).rejects.toThrow(UsageError);
  });
});
