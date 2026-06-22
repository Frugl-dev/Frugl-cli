import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cloudIdentityClient } from "./identity-client.js";
import { AuthError, FruglError } from "../lib/errors.js";

const endpointUrl = "https://frugl.example";

function makeClient() {
  return cloudIdentityClient({ endpointUrl, endpointExplicit: false, cliVersion: "9.9.9" });
}

// Records the args of each fetch call and returns the next queued Response.
interface FetchCall {
  url: string;
  init: RequestInit;
}

const calls: FetchCall[] = [];
let responder: (url: string, init: RequestInit) => Response;

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

beforeEach(() => {
  calls.length = 0;
  responder = () => jsonResponse(200, {});
  const fetchMock = vi.fn<typeof fetch>(async (input, init) => {
    const url = typeof input === "string" ? input : String(input);
    calls.push({ url, init: init ?? {} });
    return responder(url, init ?? {});
  });
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("cloudIdentityClient.requestOtp", () => {
  it("POSTs the email to the OTP request endpoint, unauthenticated", async () => {
    responder = () => jsonResponse(200, { ok: true });
    await makeClient().requestOtp("user@acme.dev");

    expect(calls).toHaveLength(1);
    const call = calls[0]!;
    expect(call.url).toBe(`${endpointUrl}/api/auth/otp/request`);
    expect(call.init.method).toBe("POST");
    expect(JSON.parse(String(call.init.body))).toEqual({ email: "user@acme.dev" });
    const headers = call.init.headers as Record<string, string>;
    expect(headers["Authorization"]).toBeUndefined();
  });

  it("rejects when the OTP request response fails schema validation", async () => {
    responder = () => jsonResponse(200, { ok: false });
    await expect(makeClient().requestOtp("user@acme.dev")).rejects.toBeInstanceOf(FruglError);
  });
});

describe("cloudIdentityClient.verifyOtp", () => {
  it("maps the verify response into { userId, token } from the session access_token", async () => {
    responder = () =>
      jsonResponse(200, {
        user_id: "u_42",
        session: {
          access_token: "tok_live",
          refresh_token: "tok_refresh",
          expires_at: "2026-07-01T00:00:00.000Z",
        },
      });

    const result = await makeClient().verifyOtp("user@acme.dev", "123456");

    expect(result).toEqual({ userId: "u_42", token: "tok_live" });
    const call = calls[0]!;
    expect(call.url).toBe(`${endpointUrl}/api/auth/otp/verify`);
    expect(JSON.parse(String(call.init.body))).toEqual({ email: "user@acme.dev", code: "123456" });
  });

  it("surfaces a 401 from a bad code as an AuthError", async () => {
    responder = () => jsonResponse(401, { error: "invalid_code" });
    await expect(makeClient().verifyOtp("user@acme.dev", "000000")).rejects.toBeInstanceOf(
      AuthError,
    );
  });

  it("rejects when the verify response is missing the session access_token", async () => {
    responder = () => jsonResponse(200, { user_id: "u_42", session: { refresh_token: "r" } });
    await expect(makeClient().verifyOtp("user@acme.dev", "123456")).rejects.toBeInstanceOf(
      FruglError,
    );
  });
});

describe("cloudIdentityClient.fetchIdentity", () => {
  it("GETs whoami with a bearer token and maps the wire fields to { userId, email }", async () => {
    responder = () =>
      jsonResponse(200, {
        user_id: "u_99",
        primary_email: "who@acme.dev",
        providers: ["google"],
      });

    const identity = await makeClient().fetchIdentity("frugl_pat_x");

    expect(identity).toEqual({ userId: "u_99", email: "who@acme.dev" });
    const call = calls[0]!;
    expect(call.url).toBe(`${endpointUrl}/api/auth/whoami`);
    expect(call.init.method).toBe("GET");
    const headers = call.init.headers as Record<string, string>;
    expect(headers["Authorization"]).toBe("Bearer frugl_pat_x");
  });

  it("maps a 403 (revoked token) into an AuthError carrying the status", async () => {
    responder = () => jsonResponse(403, { error: "revoked" });
    const error = await makeClient()
      .fetchIdentity("frugl_pat_bad")
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AuthError);
    expect((error as AuthError).status).toBe(403);
  });

  it("rejects when whoami returns a non-email primary_email (schema mismatch)", async () => {
    responder = () => jsonResponse(200, { user_id: "u_99", primary_email: "not-an-email" });
    await expect(makeClient().fetchIdentity("tok")).rejects.toBeInstanceOf(FruglError);
  });

  it("rejects with a parse error when whoami returns malformed JSON", async () => {
    responder = () =>
      new Response("{not json", {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    await expect(makeClient().fetchIdentity("tok")).rejects.toThrow(/Failed to parse JSON/);
  });
});
