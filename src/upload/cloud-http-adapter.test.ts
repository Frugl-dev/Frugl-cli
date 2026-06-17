import { describe, it, expect, vi } from "vitest";
import { CloudClient } from "../cloud/client.js";
import { HttpCloudAdapter } from "./cloud-http-adapter.js";

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
