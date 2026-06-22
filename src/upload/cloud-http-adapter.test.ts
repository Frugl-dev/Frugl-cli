import { describe, it, expect, vi } from "vitest";
import { CloudClient, CloudHttpError } from "../cloud/client.js";
import { HttpCloudAdapter } from "./cloud-http-adapter.js";
import { FruglError, NetworkError, OrgBlockedError } from "../lib/errors.js";
import { CloudPortError } from "./cloud-port.js";
import type { CreateManifestRequest } from "../cloud/schemas.js";

// `/complete` does work proportional to the number of sessions in the upload
// (Storage stats, metadata/snapshot persist, durable enqueue) and previously
// rode the 8s control-plane default, which aborted large uploads mid-flight.
// It must request its own generous timeout instead.

type CallOpts = { path: string; timeoutMs?: number };

function adapterWithSpy(): {
  adapter: HttpCloudAdapter;
  call: ReturnType<typeof vi.fn<(opts: CallOpts) => Promise<unknown>>>;
} {
  const client = new CloudClient({
    endpointUrl: "https://app.frugl.dev",
    cliVersion: "0.0.0",
  });
  const call = vi
    .fn<(opts: CallOpts) => Promise<unknown>>()
    .mockResolvedValue({ manifest_id: "m1", dashboard_url: "/dashboard" });
  // Stub the typed control-plane call so we can assert the opts the adapter
  // passes (the wire layer is exercised in client.test.ts).
  (client as unknown as { call: typeof call }).call = call;
  return { adapter: new HttpCloudAdapter(client), call };
}

describe("HttpCloudAdapter.completeManifest", () => {
  it("uses a generous timeout, not the 8s control-plane default", async () => {
    const { adapter, call } = adapterWithSpy();
    await adapter.completeManifest("m1", { secret: 3 });
    const opts = call.mock.calls[0]![0];
    expect(opts.path).toBe("/api/uploads/m1/complete");
    expect(opts.timeoutMs).toBeGreaterThanOrEqual(60_000);
  });

  it("resolves a relative dashboard path against the endpoint", async () => {
    const { adapter } = adapterWithSpy();
    const result = await adapter.completeManifest("m1", {});
    expect(result).toEqual({
      manifestId: "m1",
      dashboardUrl: "https://app.frugl.dev/dashboard",
    });
  });
});

describe("HttpCloudAdapter.createManifest billing gate (org_blocked)", () => {
  const REQ: CreateManifestRequest = {
    cli_version: "0.1.4",
    redaction_policy_version: "v0.2",
    source_kind: "claude-code",
    expected_session_count: 1,
    sessions: [{ session_id: "s1", format_version: "claude-code/v1", expected_bytes: 10 }],
  };

  it("throws OrgBlockedError on 429 org_blocked, resolving a relative upgrade_url", async () => {
    const { adapter, call } = adapterWithSpy();
    call.mockRejectedValue(
      new CloudHttpError(
        429,
        {
          error: "org_blocked",
          reason: "trial_expired",
          used: 0,
          limit: 0,
          expires_at: "2026-07-03T00:00:00Z",
          upgrade_url: "/acme/billing",
        },
        "blocked",
      ),
    );
    const err = await adapter.createManifest(REQ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(OrgBlockedError);
    expect(err).toMatchObject({
      reason: "trial_expired",
      used: 0,
      limit: 0,
      expiresAt: "2026-07-03T00:00:00Z",
      upgradeUrl: "https://app.frugl.dev/acme/billing",
      exitCode: 0,
    });
  });

  it("passes an absolute upgrade_url through unchanged and carries the quota", async () => {
    const { adapter, call } = adapterWithSpy();
    call.mockRejectedValue(
      new CloudHttpError(
        429,
        {
          error: "org_blocked",
          reason: "session_limit_reached",
          used: 2500,
          limit: 2500,
          expires_at: "2026-07-01T00:00:00Z",
          upgrade_url: "https://app.frugl.dev/acme/billing",
        },
        "blocked",
      ),
    );
    const err = (await adapter.createManifest(REQ).catch((e: unknown) => e)) as OrgBlockedError;
    expect(err).toBeInstanceOf(OrgBlockedError);
    expect(err.reason).toBe("session_limit_reached");
    expect(err.used).toBe(2500);
    expect(err.limit).toBe(2500);
    expect(err.upgradeUrl).toBe("https://app.frugl.dev/acme/billing");
  });

  it("does not mistake a snapshot weekly cap (429) for an org block", async () => {
    const { adapter, call } = adapterWithSpy();
    call.mockRejectedValue(
      new CloudHttpError(
        429,
        {
          error: "snapshot_cap_reached",
          cap: 5,
          used: 5,
          window_resets_at: "2026-07-01T00:00:00Z",
        },
        "cap",
      ),
    );
    await expect(adapter.createManifest(REQ)).resolves.toEqual({
      kind: "cap_reached",
      cap: 5,
      used: 5,
      windowResetsAt: "2026-07-01T00:00:00Z",
    });
  });

  it("translates a 409 org_required into actionable FruglError setup guidance", async () => {
    const { adapter, call } = adapterWithSpy();
    call.mockRejectedValue(new CloudHttpError(409, { error: "org_required" }, "no org"));
    const err = (await adapter.createManifest(REQ).catch((e: unknown) => e)) as FruglError;
    expect(err).toBeInstanceOf(FruglError);
    expect(err.message).toContain("frugl setup");
  });

  it("defaults org_blocked reason/upgrade_url/quotas when malformed", async () => {
    const { adapter, call } = adapterWithSpy();
    call.mockRejectedValue(
      new CloudHttpError(429, { error: "org_blocked", reason: "weird" }, "blocked"),
    );
    const err = (await adapter.createManifest(REQ).catch((e: unknown) => e)) as OrgBlockedError;
    expect(err).toBeInstanceOf(OrgBlockedError);
    expect(err.reason).toBe("session_limit_reached");
    expect(err.used).toBe(0);
    expect(err.limit).toBe(0);
    expect(err.expiresAt).toBeNull();
    expect(err.upgradeUrl).toBe("https://app.frugl.dev/pricing");
  });

  it("defaults snapshot_cap fields to 0/empty when malformed", async () => {
    const { adapter, call } = adapterWithSpy();
    call.mockRejectedValue(new CloudHttpError(429, { error: "snapshot_cap_reached" }, "cap"));
    await expect(adapter.createManifest(REQ)).resolves.toEqual({
      kind: "cap_reached",
      cap: 0,
      used: 0,
      windowResetsAt: "",
    });
  });

  it("maps an unrelated CloudHttpError to a CloudPortError preserving status", async () => {
    const { adapter, call } = adapterWithSpy();
    call.mockRejectedValue(new CloudHttpError(500, { error: "boom" }, "server error"));
    const err = (await adapter.createManifest(REQ).catch((e: unknown) => e)) as CloudPortError;
    expect(err).toBeInstanceOf(CloudPortError);
    expect(err.status).toBe(500);
  });

  it("maps a NetworkError to a CloudPortError without a status", async () => {
    const { adapter, call } = adapterWithSpy();
    call.mockRejectedValue(new NetworkError("offline"));
    const err = (await adapter.createManifest(REQ).catch((e: unknown) => e)) as CloudPortError;
    expect(err).toBeInstanceOf(CloudPortError);
    expect(err.status).toBeUndefined();
  });

  it("passes a non-CloudHttpError (429 but not a known error body) through normal mapping", async () => {
    const { adapter, call } = adapterWithSpy();
    // 429 with a non-object body — both readCapReached and readOrgBlocked bail
    // (body is not an object), so it falls through to toCloudPortError.
    call.mockRejectedValue(new CloudHttpError(429, "throttled", "too many"));
    const err = (await adapter.createManifest(REQ).catch((e: unknown) => e)) as CloudPortError;
    expect(err).toBeInstanceOf(CloudPortError);
    expect(err.status).toBe(429);
  });

  it("re-throws an already transport-agnostic error untouched", async () => {
    const { adapter, call } = adapterWithSpy();
    const portErr = new CloudPortError("nested PUT failed", { status: 403 });
    call.mockRejectedValue(portErr);
    const err = await adapter.createManifest(REQ).catch((e: unknown) => e);
    expect(err).toBe(portErr);
  });

  it("returns a created result carrying the upload id on success", async () => {
    const { adapter, call } = adapterWithSpy();
    call.mockResolvedValue({ upload_id: "up_1" });
    await expect(adapter.createManifest(REQ)).resolves.toEqual({
      kind: "created",
      uploadId: "up_1",
    });
  });

  it("returns a no_change result when the server skips the upload", async () => {
    const { adapter, call } = adapterWithSpy();
    call.mockResolvedValue({ status: "no_change" });
    await expect(adapter.createManifest(REQ)).resolves.toEqual({ kind: "no_change" });
  });
});

describe("HttpCloudAdapter.presign", () => {
  it("returns the presigned url + a copy of the headers", async () => {
    const { adapter, call } = adapterWithSpy();
    call.mockResolvedValue({
      presigned_url: "https://storage/put",
      headers: { "content-type": "application/json" },
    });
    const result = await adapter.presign("m1", "s1");
    expect(result).toEqual({
      url: "https://storage/put",
      headers: { "content-type": "application/json" },
    });
    expect(call.mock.calls[0]![0].path).toBe("/api/uploads/m1/presign");
  });

  it("maps a presign failure onto a CloudPortError", async () => {
    const { adapter, call } = adapterWithSpy();
    call.mockRejectedValue(new CloudHttpError(403, {}, "expired"));
    const err = (await adapter.presign("m1", "s1").catch((e: unknown) => e)) as CloudPortError;
    expect(err).toBeInstanceOf(CloudPortError);
    expect(err.status).toBe(403);
  });

  it("maps a completeManifest failure onto a CloudPortError", async () => {
    const { adapter, call } = adapterWithSpy();
    call.mockRejectedValue(new CloudHttpError(409, {}, "conflict"));
    const err = (await adapter
      .completeManifest("m1", {})
      .catch((e: unknown) => e)) as CloudPortError;
    expect(err).toBeInstanceOf(CloudPortError);
    expect(err.status).toBe(409);
  });
});

function adapterWithPut(response: { ok: boolean; status?: number; text?: () => Promise<string> }): {
  adapter: HttpCloudAdapter;
  putBody: ReturnType<typeof vi.fn<(...args: unknown[]) => Promise<unknown>>>;
} {
  const client = new CloudClient({ endpointUrl: "https://app.frugl.dev", cliVersion: "0.0.0" });
  const putBody = vi.fn<(...args: unknown[]) => Promise<unknown>>().mockResolvedValue(response);
  (client as unknown as { putBody: typeof putBody }).putBody = putBody;
  return { adapter: new HttpCloudAdapter(client), putBody };
}

describe("HttpCloudAdapter.putSessionBody", () => {
  it("resolves when the PUT is ok", async () => {
    const { adapter, putBody } = adapterWithPut({ ok: true });
    await expect(
      adapter.putSessionBody("https://storage/put", new Uint8Array([1, 2]), { h: "v" }),
    ).resolves.toBeUndefined();
    expect(putBody).toHaveBeenCalledOnce();
  });

  it("throws a CloudPortError with the status + body on a non-ok PUT", async () => {
    const { adapter } = adapterWithPut({
      ok: false,
      status: 403,
      text: () => Promise.resolve("denied"),
    });
    const err = (await adapter
      .putSessionBody("https://storage/put", new Uint8Array([1]), {})
      .catch((e: unknown) => e)) as CloudPortError;
    expect(err).toBeInstanceOf(CloudPortError);
    expect(err.status).toBe(403);
    expect(err.body).toBe("denied");
  });

  it("tolerates a failed response.text() read, falling back to empty body", async () => {
    const { adapter } = adapterWithPut({
      ok: false,
      status: 500,
      text: () => Promise.reject(new Error("stream broke")),
    });
    const err = (await adapter
      .putSessionBody("https://storage/put", new Uint8Array([1]), {})
      .catch((e: unknown) => e)) as CloudPortError;
    expect(err).toBeInstanceOf(CloudPortError);
    expect(err.status).toBe(500);
    expect(err.body).toBe("");
  });
});
