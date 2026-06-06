import { describe, expect, it } from "vitest";
import {
  HANDOFF_TIMEOUT_MS,
  requestHandoffUrl,
  resolveHandoffPreference,
  type HandoffClient,
} from "./handoff.js";
import { handoffRequestSchema, handoffResponseSchema } from "./schemas.js";
import { CloudHttpError } from "./client.js";
import {
  AuthError,
  EndpointError,
  FruglError,
  NetworkError,
  VersionGateError,
} from "../lib/errors.js";
import { EXIT } from "../lib/exit-codes.js";

const ON = { active: true, source: "default" } as const;

// A stub client that records the call it received and resolves/rejects on cue.
function stubClient(impl: { grant?: { code: string; expires_at: string }; error?: unknown }): {
  client: HandoffClient;
  calls: Array<{ method: string; path: string; body: unknown; timeoutMs?: number | undefined }>;
} {
  const calls: Array<{ method: string; path: string; body: unknown; timeoutMs?: number }> = [];
  const client: HandoffClient = {
    call(opts) {
      calls.push({
        method: opts.method,
        path: opts.path,
        body: opts.body,
        ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
      });
      if (impl.error !== undefined) return Promise.reject(impl.error);
      // The schema parse is the client's job in production; mirror it here so
      // the stub honors the same contract surface.
      return Promise.resolve(handoffResponseSchema.parse(impl.grant));
    },
  };
  return { client, calls };
}

// ---- Contract fixtures (T003): zod round-trip + open-redirect guard ----

describe("handoff wire schemas (contract)", () => {
  it("accepts a relative redirect_to and round-trips the response", () => {
    expect(
      handoffRequestSchema.parse({ redirect_to: "/dashboard/uploads/mfst_1?tab=waste" }),
    ).toEqual({ redirect_to: "/dashboard/uploads/mfst_1?tab=waste" });
    expect(
      handoffResponseSchema.parse({ code: "hof_abc", expires_at: "2026-06-06T12:01:00.000Z" }),
    ).toEqual({ code: "hof_abc", expires_at: "2026-06-06T12:01:00.000Z" });
  });

  it.each([
    ["absolute URL", "https://evil.example/phish"],
    ["protocol-relative", "//evil.example/phish"],
    ["embedded scheme", "/redirect?to=https://x"], // `://` anywhere is rejected
    ["no leading slash", "dashboard/uploads/x"],
    ["empty", ""],
  ])("rejects non-relative redirect_to: %s", (_label, value) => {
    expect(handoffRequestSchema.safeParse({ redirect_to: value }).success).toBe(false);
  });

  it("rejects a grant missing code or expires_at", () => {
    expect(handoffResponseSchema.safeParse({ code: "x" }).success).toBe(false);
    expect(handoffResponseSchema.safeParse({ expires_at: "t" }).success).toBe(false);
    expect(handoffResponseSchema.safeParse({ code: "", expires_at: "t" }).success).toBe(false);
  });
});

// ---- Preference precedence (T016): full truth table from data-model.md ----

describe("resolveHandoffPreference", () => {
  it.each([
    // flag        isTTY   mode      active  source
    [false, true, "text", false, "flag"], // --no-handoff wins everything
    [false, false, "json", false, "flag"],
    [true, false, "json", true, "flag"], // --handoff forces on in JSON/non-TTY
    [true, false, "text", true, "flag"],
    [undefined, true, "text", true, "default"], // unset: on only when TTY ∧ text
    [undefined, false, "text", false, "default"],
    [undefined, true, "json", false, "default"],
    [undefined, false, "json", false, "default"],
  ] as const)("flag=%s isTTY=%s mode=%s → active=%s (%s)", (flag, isTTY, mode, active, source) => {
    expect(resolveHandoffPreference(flag, isTTY, mode)).toEqual({ active, source });
  });
});

// ---- Happy path (T004): derivation + decoration ----

describe("requestHandoffUrl — success", () => {
  const grant = { code: "hof_abc123", expires_at: "2026-06-06T12:01:00.000Z" };

  it("derives redirect_to as pathname+search (never host) and posts with the 3s cap", async () => {
    const { client, calls } = stubClient({ grant });
    await requestHandoffUrl(client, "https://app.frugl.test/dashboard/uploads/m1?tab=waste", ON);
    expect(calls).toEqual([
      {
        method: "POST",
        path: "/api/auth/handoff",
        body: { redirect_to: "/dashboard/uploads/m1?tab=waste" },
        timeoutMs: HANDOFF_TIMEOUT_MS,
      },
    ]);
  });

  it("decorates the URL via searchParams, preserving existing query params", async () => {
    const { client } = stubClient({ grant });
    const result = await requestHandoffUrl(
      client,
      "https://app.frugl.test/dashboard/uploads/m1?tab=waste",
      ON,
    );
    expect(result).toEqual({
      active: true,
      dashboardUrl: "https://app.frugl.test/dashboard/uploads/m1?tab=waste&handoff=hof_abc123",
      expiresAt: grant.expires_at,
    });
  });

  it("returns active:true with the plain path when there is no query string", async () => {
    const { client } = stubClient({ grant });
    const result = await requestHandoffUrl(client, "https://app.frugl.test/dashboard", ON);
    expect(result.dashboardUrl).toBe("https://app.frugl.test/dashboard?handoff=hof_abc123");
  });
});

// ---- Skip paths (T016/T017): inactive preference makes no wire call ----

describe("requestHandoffUrl — disabled", () => {
  it.each([
    [{ active: false, source: "flag" } as const, "disabled-flag"],
    [{ active: false, source: "default" } as const, "disabled-default"],
  ])("preference %o short-circuits with %s and zero wire calls", async (preference, reason) => {
    const { client, calls } = stubClient({ grant: { code: "x", expires_at: "t" } });
    const result = await requestHandoffUrl(client, "https://app.frugl.test/dashboard", preference);
    expect(result).toEqual({
      active: false,
      dashboardUrl: "https://app.frugl.test/dashboard",
      reason,
    });
    expect(calls).toEqual([]);
  });
});

// ---- Failure taxonomy (T012): every class degrades, nothing escapes ----

describe("requestHandoffUrl — degradation (never throws, plain URL back)", () => {
  const URL_IN = "https://app.frugl.test/dashboard/uploads/m1";

  it.each([
    ["404 endpoint absent", new CloudHttpError(404, "", "HTTP 404"), "unsupported"],
    ["405 method not allowed", new CloudHttpError(405, "", "HTTP 405"), "unsupported"],
    ["400 invalid redirect", new CloudHttpError(400, {}, "HTTP 400"), "rejected"],
    ["auth failed mid-run", new AuthError("Authentication failed (401)."), "rejected"],
    ["429 rate limited", new CloudHttpError(429, "", "HTTP 429"), "unavailable"],
    ["500 server error", new CloudHttpError(500, "", "HTTP 500"), "unavailable"],
    ["version gate", new VersionGateError("0.1.0", "9.9.9"), "unavailable"],
    [
      "network error",
      new NetworkError("Network error calling POST /api/auth/handoff"),
      "unavailable",
    ],
    ["explicit endpoint unreachable", new EndpointError("unreachable"), "unavailable"],
    [
      "schema mismatch",
      new FruglError(
        "Cloud response schema mismatch on POST /api/auth/handoff: code",
        EXIT.GENERIC_FAILURE,
      ),
      "unavailable",
    ],
    [
      "timeout abort",
      new NetworkError("Network error calling POST /api/auth/handoff: This operation was aborted"),
      "unavailable",
    ],
    ["non-Error throw", "boom", "unavailable"],
  ])("%s → { active: false, reason: %s }", async (_label, error, reason) => {
    const { client } = stubClient({ error });
    const result = await requestHandoffUrl(client, URL_IN, ON);
    expect(result).toEqual({ active: false, dashboardUrl: URL_IN, reason });
  });

  it("degrades to rejected on an unparseable dashboard URL instead of throwing", async () => {
    const { client, calls } = stubClient({ grant: { code: "x", expires_at: "t" } });
    const result = await requestHandoffUrl(client, "not a url", ON);
    expect(result).toEqual({ active: false, dashboardUrl: "not a url", reason: "rejected" });
    expect(calls).toEqual([]);
  });
});
