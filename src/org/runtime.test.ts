import { describe, it, expect, vi } from "vitest";
import { fetchOrgContext } from "./runtime.js";
import { CloudHttpError, type CloudClient } from "../cloud/client.js";
import type { z } from "zod";

// Minimal fake CloudClient: records each call and returns (or throws) a queued
// response keyed by `METHOD path`, mirroring setup.test.ts's makeFakeClient.
interface FakeCall {
  method: string;
  path: string;
}

function makeFakeClient(responses: Record<string, unknown | Error>) {
  const calls: FakeCall[] = [];
  const client = {
    calls,
    async call({ method, path }: { method: string; path: string; schema: z.ZodTypeAny }) {
      calls.push({ method, path });
      const response = responses[`${method} ${path}`];
      if (response instanceof Error) throw response;
      return response;
    },
  };
  return client;
}

function orgRequiredError() {
  return new CloudHttpError(409, { error: "org_required" }, "HTTP 409");
}

describe("fetchOrgContext", () => {
  it("maps a member response to kind=member, threading role and slug", async () => {
    const client = makeFakeClient({
      "GET /api/orgs/me": {
        org: { id: "o1", name: "Acme", slug: "acme" },
        membership: { role: "owner" },
      },
    });

    const ctx = await fetchOrgContext(client as unknown as CloudClient);

    expect(ctx).toEqual({ kind: "member", slug: "acme", name: "Acme", role: "owner" });
    // Calls GET /api/orgs/me exactly once.
    expect(client.calls).toEqual([{ method: "GET", path: "/api/orgs/me" }]);
  });

  it("includes memberCount only when the wire carries member_count", async () => {
    const client = makeFakeClient({
      "GET /api/orgs/me": {
        org: { id: "o1", name: "Acme", slug: "acme", member_count: 7 },
        membership: { role: "member" },
      },
    });

    const ctx = await fetchOrgContext(client as unknown as CloudClient);

    expect(ctx).toEqual({
      kind: "member",
      slug: "acme",
      name: "Acme",
      role: "member",
      memberCount: 7,
    });
  });

  it("omits memberCount (no undefined key) when member_count is absent", async () => {
    const client = makeFakeClient({
      "GET /api/orgs/me": {
        org: { id: "o1", name: "Acme", slug: "acme" },
        membership: { role: "owner" },
      },
    });

    const ctx = await fetchOrgContext(client as unknown as CloudClient);

    expect("memberCount" in ctx).toBe(false);
  });

  it("models a 409 org_required as data (kind=none), not an error", async () => {
    const client = makeFakeClient({ "GET /api/orgs/me": orgRequiredError() });

    const ctx = await fetchOrgContext(client as unknown as CloudClient);

    expect(ctx).toEqual({ kind: "none" });
  });

  it("propagates a non-409 CloudHttpError unchanged", async () => {
    const boom = new CloudHttpError(500, { error: "server_error" }, "HTTP 500");
    const client = makeFakeClient({ "GET /api/orgs/me": boom });

    await expect(fetchOrgContext(client as unknown as CloudClient)).rejects.toBe(boom);
  });

  it("propagates a non-Cloud error (e.g. network) unchanged", async () => {
    const network = new Error("network down");
    const client = {
      async call() {
        throw network;
      },
    };

    await expect(fetchOrgContext(client as unknown as CloudClient)).rejects.toBe(network);
  });

  it("does not treat a non-409 status that happens to be CloudHttpError as none", async () => {
    // 403 is a real failure, not the org_required sentinel.
    const forbidden = new CloudHttpError(403, { error: "forbidden" }, "HTTP 403");
    const client = makeFakeClient({ "GET /api/orgs/me": forbidden });

    await expect(fetchOrgContext(client as unknown as CloudClient)).rejects.toBeInstanceOf(
      CloudHttpError,
    );
  });

  it("passes the orgMe schema to the client call", async () => {
    const schemaSpy = vi.fn<(opts: { schema: z.ZodTypeAny }) => Promise<unknown>>(async () => ({
      org: { id: "o1", name: "Acme", slug: "acme" },
      membership: { role: "owner" },
    }));
    const client = { call: schemaSpy };

    await fetchOrgContext(client as unknown as CloudClient);

    expect(schemaSpy).toHaveBeenCalledOnce();
    const arg = schemaSpy.mock.calls[0]?.[0] as { method: string; path: string; schema: unknown };
    expect(arg.method).toBe("GET");
    expect(arg.path).toBe("/api/orgs/me");
    // A schema is supplied so the client validates the response shape.
    expect(arg.schema).toBeDefined();
  });
});
