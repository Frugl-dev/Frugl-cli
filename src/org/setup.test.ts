import { describe, it, expect } from "vitest";
import { setupOrg } from "./setup.js";
import { CloudHttpError } from "../cloud/client.js";
import { z } from "zod";

interface FakeCall {
  method: string;
  path: string;
  body?: unknown;
}

function makeFakeClient(responses: Record<string, unknown | Error>) {
  const calls: FakeCall[] = [];
  return {
    calls,
    endpointUrl: "https://test",
    setToken: () => {},
    async call({
      method,
      path,
      body,
    }: {
      method: string;
      path: string;
      body?: unknown;
      schema: z.ZodTypeAny;
    }) {
      calls.push({ method, path, body });
      const key = `${method} ${path}`;
      const response = responses[key];
      if (response instanceof Error) throw response;
      return response;
    },
  };
}

function orgRequiredError() {
  return new CloudHttpError(409, { error: "org_required" }, "HTTP 409");
}

function slugTakenError(suggestion: string) {
  return new CloudHttpError(409, { error: "slug_taken", details: { suggestion } }, "HTTP 409");
}

describe("setupOrg", () => {
  it("returns already-setup when org exists", async () => {
    const client = makeFakeClient({
      "GET /api/orgs/me": {
        org: { id: "o1", name: "Acme", slug: "acme" },
        membership: { role: "owner" },
      },
    });
    const result = await setupOrg(client as never, {
      action: "create",
      name: "Acme",
      slug: "acme",
    });
    expect(result.status).toBe("already-setup");
    expect(client.calls).toHaveLength(1);
  });

  it("creates a new org", async () => {
    const client = makeFakeClient({
      "GET /api/orgs/me": orgRequiredError(),
      "POST /api/orgs/create": { id: "o1", name: "Acme", slug: "acme" },
    });
    const result = await setupOrg(client as never, {
      action: "create",
      name: "Acme",
      slug: "acme",
    });
    expect(result.status).toBe("created");
    expect((result as { status: "created"; slug: string }).slug).toBe("acme");
  });

  it("joins an org with invite code", async () => {
    const client = makeFakeClient({
      "GET /api/orgs/me": orgRequiredError(),
      "POST /api/join": { org: { name: "Their Org", slug: "their-org" } },
    });
    const result = await setupOrg(client as never, { action: "join", code: "ABC123" });
    expect(result.status).toBe("joined");
  });

  it("returns slug-taken when create conflicts", async () => {
    const client = makeFakeClient({
      "GET /api/orgs/me": orgRequiredError(),
      "POST /api/orgs/create": slugTakenError("acme-1"),
    });
    const result = await setupOrg(client as never, {
      action: "create",
      name: "Acme",
      slug: "acme",
    });
    expect(result.status).toBe("slug-taken");
    expect((result as { status: "slug-taken"; suggestion: string }).suggestion).toBe("acme-1");
  });

  it("returns invalid-code when join code not found", async () => {
    const client = makeFakeClient({
      "GET /api/orgs/me": orgRequiredError(),
      "POST /api/join": new CloudHttpError(404, { error: "not_found" }, "HTTP 404"),
    });
    const result = await setupOrg(client as never, { action: "join", code: "BADCODE" });
    expect(result.status).toBe("invalid-code");
  });

  it("returns expired-code when join code is exhausted or expired", async () => {
    const client = makeFakeClient({
      "GET /api/orgs/me": orgRequiredError(),
      "POST /api/join": new CloudHttpError(410, { error: "expired" }, "HTTP 410"),
    });
    const result = await setupOrg(client as never, { action: "join", code: "OLDCODE" });
    expect(result.status).toBe("expired-code");
  });

  it("throws on rate limit", async () => {
    const client = makeFakeClient({
      "GET /api/orgs/me": orgRequiredError(),
      "POST /api/join": new CloudHttpError(
        429,
        { error: "rate_limited", details: { retry_after_seconds: 30 } },
        "HTTP 429",
      ),
    });
    await expect(setupOrg(client as never, { action: "join", code: "CODE" })).rejects.toThrow(
      "Too many attempts.",
    );
  });
});
