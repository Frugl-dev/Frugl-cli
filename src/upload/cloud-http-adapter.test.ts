import { describe, it, expect, vi } from "vitest";
import { CloudClient, CloudHttpError } from "../cloud/client.js";
import { HttpCloudAdapter } from "./cloud-http-adapter.js";
import { OrgBlockedError } from "../lib/errors.js";
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
});
