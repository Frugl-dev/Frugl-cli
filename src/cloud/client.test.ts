import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { CloudClient, CloudHttpError, describeHttpError, isAuthHttpError } from "./client.js";
import {
  AuthError,
  EndpointError,
  FruglError,
  NetworkError,
  VersionGateError,
} from "../lib/errors.js";
import { EXIT } from "../lib/exit-codes.js";

// All of these tests stub the global `fetch` so we exercise the wire layer
// (header/url construction, status mapping, schema validation) without a server.
// The happy-path round trip is already covered by the e2e + adapter suites, so
// here we target the branch logic that those don't reach.

const OK = z.object({ value: z.string() });

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function newClient(overrides: Partial<ConstructorParameters<typeof CloudClient>[0]> = {}) {
  return new CloudClient({
    endpointUrl: "https://app.frugl.dev",
    cliVersion: "1.2.3",
    ...overrides,
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("CloudClient.call — request construction", () => {
  it("builds the URL from endpoint + path and sends version headers", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse(200, { value: "ok" }));
    vi.stubGlobal("fetch", fetchMock);

    await newClient().call({ method: "GET", path: "/api/thing", schema: OK });

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("https://app.frugl.dev/api/thing");
    expect(init?.method).toBe("GET");
    const headers = init?.headers as Record<string, string>;
    expect(headers["X-Frugl-Client"]).toBe("frugl-cli/1.2.3");
    expect(headers["X-Frugl-CLI-Version"]).toBe("1.2.3");
    // No body ⇒ no Content-Type, null body.
    expect(headers["Content-Type"]).toBeUndefined();
    expect(init?.body).toBeNull();
  });

  it("serializes a JSON body and sets Content-Type when a body is present", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse(200, { value: "ok" }));
    vi.stubGlobal("fetch", fetchMock);

    await newClient().call({
      method: "POST",
      path: "/api/thing",
      body: { a: 1 },
      schema: OK,
    });

    const init = fetchMock.mock.calls[0]![1];
    const headers = init?.headers as Record<string, string>;
    expect(headers["Content-Type"]).toBe("application/json");
    expect(init?.body).toBe(JSON.stringify({ a: 1 }));
  });

  it("adds a Bearer header when a token is set and the call is authenticated", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse(200, { value: "ok" }));
    vi.stubGlobal("fetch", fetchMock);

    const client = newClient({ token: "tok-abc" });
    await client.call({ method: "GET", path: "/api/me", schema: OK });

    const headers = fetchMock.mock.calls[0]![1]?.headers as Record<string, string>;
    expect(headers["Authorization"]).toBe("Bearer tok-abc");
  });

  it("omits the Bearer header when authenticated:false even if a token is set", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse(200, { value: "ok" }));
    vi.stubGlobal("fetch", fetchMock);

    const client = newClient({ token: "tok-abc" });
    await client.call({
      method: "GET",
      path: "/api/public",
      schema: OK,
      authenticated: false,
    });

    const headers = fetchMock.mock.calls[0]![1]?.headers as Record<string, string>;
    expect(headers["Authorization"]).toBeUndefined();
  });

  it("omits the Bearer header when no token is set", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse(200, { value: "ok" }));
    vi.stubGlobal("fetch", fetchMock);

    await newClient().call({ method: "GET", path: "/api/thing", schema: OK });

    const headers = fetchMock.mock.calls[0]![1]?.headers as Record<string, string>;
    expect(headers["Authorization"]).toBeUndefined();
  });

  it("setToken updates the Authorization header on subsequent calls", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse(200, { value: "ok" }));
    vi.stubGlobal("fetch", fetchMock);

    const client = newClient();
    client.setToken("late-token");
    await client.call({ method: "GET", path: "/api/thing", schema: OK });

    const headers = fetchMock.mock.calls[0]![1]?.headers as Record<string, string>;
    expect(headers["Authorization"]).toBe("Bearer late-token");
  });
});

describe("CloudClient.call — status mapping", () => {
  it("maps 401 to an AuthError carrying the status (exit 10)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>().mockResolvedValue(jsonResponse(401, { error: "nope" })),
    );
    const err = await newClient()
      .call({ method: "GET", path: "/x", schema: OK })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AuthError);
    expect((err as AuthError).status).toBe(401);
    expect((err as AuthError).exitCode).toBe(EXIT.AUTH_FAILURE);
  });

  it("maps 403 to an AuthError carrying the status", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>().mockResolvedValue(jsonResponse(403, { error: "forbidden" })),
    );
    const err = await newClient()
      .call({ method: "GET", path: "/x", schema: OK })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AuthError);
    expect((err as AuthError).status).toBe(403);
  });

  it("throws CloudHttpError for a generic non-ok status with status + parsed body", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>().mockResolvedValue(jsonResponse(500, { error: "boom" })),
    );
    const err = await newClient()
      .call({ method: "POST", path: "/x", schema: OK })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CloudHttpError);
    const httpErr = err as CloudHttpError;
    expect(httpErr.status).toBe(500);
    expect(httpErr.body).toEqual({ error: "boom" });
    expect(httpErr.message).toContain("HTTP 500");
  });

  it("preserves a non-JSON error body on CloudHttpError", async () => {
    // handleResponse reads the body once as text and only then tries JSON.parse,
    // so a non-JSON error body (e.g. a proxy/gateway plain-text page) is kept on
    // the error rather than being lost to a double-read of the response stream.
    const resp = new Response("plain text failure", { status: 502 });
    vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockResolvedValue(resp));
    const err = (await newClient()
      .call({ method: "GET", path: "/x", schema: OK })
      .catch((e: unknown) => e)) as CloudHttpError;
    expect(err).toBeInstanceOf(CloudHttpError);
    expect(err.status).toBe(502);
    expect(err.body).toBe("plain text failure");
    expect(err.message).toContain("plain text failure");
  });

  it("maps 426 with a valid gate body to a VersionGateError naming the required version", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>().mockResolvedValue(jsonResponse(426, { min_version: "2.0.0" })),
    );
    const err = (await newClient({ cliVersion: "1.2.3" })
      .call({ method: "GET", path: "/x", schema: OK })
      .catch((e: unknown) => e)) as VersionGateError;
    expect(err).toBeInstanceOf(VersionGateError);
    expect(err.requiredVersion).toBe("2.0.0");
    expect(err.exitCode).toBe(EXIT.VERSION_GATE_FAILURE);
  });

  it("maps 426 with an unparseable body to a VersionGateError(unknown)", async () => {
    // Body is not JSON ⇒ handler catches, passes {} to checkVersionGate, which
    // throws VersionGateError(unknown) before the explicit fallback throw.
    const resp = new Response("<html>nope</html>", { status: 426 });
    vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockResolvedValue(resp));
    const err = (await newClient()
      .call({ method: "GET", path: "/x", schema: OK })
      .catch((e: unknown) => e)) as VersionGateError;
    expect(err).toBeInstanceOf(VersionGateError);
    expect(err.requiredVersion).toBe("unknown");
  });
});

describe("CloudClient.call — body / schema handling", () => {
  it("returns undefined for a 204 No Content without touching the schema", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 204 })),
    );
    // A schema that would reject undefined — proves we short-circuit before parse.
    const result = await newClient().call({ method: "POST", path: "/signout", schema: OK });
    expect(result).toBeUndefined();
  });

  it("returns undefined for a 200 with an empty body", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>().mockResolvedValue(new Response("", { status: 200 })),
    );
    const result = await newClient().call({ method: "GET", path: "/x", schema: OK });
    expect(result).toBeUndefined();
  });

  it("validates the body against the schema and returns the parsed value", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>().mockResolvedValue(jsonResponse(200, { value: "hi" })),
    );
    const result = await newClient().call({ method: "GET", path: "/x", schema: OK });
    expect(result).toEqual({ value: "hi" });
  });

  it("throws a FruglError(generic) when the JSON cannot be parsed", async () => {
    // 200 OK but a malformed JSON body (not the empty-body short-circuit).
    const resp = new Response("{not json", { status: 200 });
    vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockResolvedValue(resp));
    const err = (await newClient()
      .call({ method: "GET", path: "/x", schema: OK })
      .catch((e: unknown) => e)) as FruglError;
    expect(err).toBeInstanceOf(FruglError);
    expect(err.exitCode).toBe(EXIT.GENERIC_FAILURE);
    expect(err.message).toContain("Failed to parse JSON");
  });

  it("throws a FruglError naming the offending path on a schema mismatch", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>().mockResolvedValue(jsonResponse(200, { value: 123 })),
    );
    const err = (await newClient()
      .call({ method: "GET", path: "/x", schema: OK })
      .catch((e: unknown) => e)) as FruglError;
    expect(err).toBeInstanceOf(FruglError);
    expect(err.exitCode).toBe(EXIT.GENERIC_FAILURE);
    expect(err.message).toContain("schema mismatch");
    expect(err.message).toContain("value");
  });
});

describe("CloudClient.call — transport errors", () => {
  it("maps a fetch rejection to NetworkError when the endpoint is not explicit", async () => {
    vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockRejectedValue(new Error("ECONNREFUSED")));
    const err = await newClient()
      .call({ method: "GET", path: "/x", schema: OK })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(NetworkError);
    expect((err as NetworkError).message).toContain("ECONNREFUSED");
  });

  it("maps the first fetch failure to EndpointError when endpointExplicit is set", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>().mockRejectedValue(new Error("getaddrinfo ENOTFOUND")),
    );
    const err = await newClient({ endpointExplicit: true })
      .call({ method: "GET", path: "/x", schema: OK })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(EndpointError);
    expect((err as EndpointError).exitCode).toBe(EXIT.ENDPOINT_UNREACHABLE);
  });

  it("after a first success, a later fetch failure is a NetworkError even when endpointExplicit", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse(200, { value: "ok" }))
      .mockRejectedValueOnce(new Error("connection reset"));
    vi.stubGlobal("fetch", fetchMock);

    const client = newClient({ endpointExplicit: true });
    await client.call({ method: "GET", path: "/a", schema: OK });
    const err = await client
      .call({ method: "GET", path: "/b", schema: OK })
      .catch((e: unknown) => e);
    // firstCallSucceeded is now true ⇒ not an EndpointError.
    expect(err).toBeInstanceOf(NetworkError);
    expect(err).not.toBeInstanceOf(EndpointError);
  });

  it("aborts the request after the timeout elapses (surfaced as a transport error)", async () => {
    // fetch honours the AbortSignal: reject with an AbortError once aborted.
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>().mockImplementation(
        (_url, init) =>
          new Promise((_resolve, reject) => {
            const signal = (init as RequestInit | undefined)?.signal;
            signal?.addEventListener("abort", () => {
              const e = new Error("The operation was aborted");
              e.name = "AbortError";
              reject(e);
            });
          }),
      ),
    );
    const err = await newClient({ controlPlaneTimeoutMs: 5 })
      .call({ method: "GET", path: "/slow", schema: OK })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(NetworkError);
    expect((err as NetworkError).message).toContain("aborted");
  });
});

describe("describeHttpError", () => {
  it("summarizes a CloudHttpError with status and a truncated JSON body", () => {
    const err = new CloudHttpError(503, { error: "down" }, "raw");
    expect(describeHttpError(err)).toBe('HTTP 503: {"error":"down"}');
  });

  it("summarizes a CloudHttpError with a string body", () => {
    const err = new CloudHttpError(500, "internal", "raw");
    expect(describeHttpError(err)).toBe("HTTP 500: internal");
  });

  it("returns the message for a plain Error", () => {
    expect(describeHttpError(new Error("boom"))).toBe("boom");
  });

  it("stringifies a non-Error value", () => {
    expect(describeHttpError("weird")).toBe("weird");
  });
});

describe("isAuthHttpError", () => {
  it("is true for CloudHttpError with 401 / 403", () => {
    expect(isAuthHttpError(new CloudHttpError(401, {}, "x"))).toBe(true);
    expect(isAuthHttpError(new CloudHttpError(403, {}, "x"))).toBe(true);
  });

  it("is false for other statuses and non-http errors", () => {
    expect(isAuthHttpError(new CloudHttpError(500, {}, "x"))).toBe(false);
    expect(isAuthHttpError(new Error("nope"))).toBe(false);
  });
});
