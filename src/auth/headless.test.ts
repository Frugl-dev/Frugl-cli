import { describe, it, expect, vi, beforeEach } from "vitest";
import { resolveUploadAuth } from "./headless.js";
import { resolveHeadlessToken } from "./token-auth.js";
import { loadAuthSession } from "./session.js";
import { CloudClient } from "../cloud/client.js";
import { AuthError } from "../lib/errors.js";

vi.mock("./token-auth.js", () => ({ resolveHeadlessToken: vi.fn<() => unknown>() }));
vi.mock("./session.js", () => ({ loadAuthSession: vi.fn<() => unknown>() }));
vi.mock("../cloud/client.js", () => ({ CloudClient: vi.fn<() => unknown>() }));

const endpointUrl = "https://poppi.example";
const baseOpts = { endpointUrl, endpointExplicit: false };

function mockWhoami(impl: () => unknown) {
  // Implementation must be a regular function so `new CloudClient()` works.
  (CloudClient as any).mockImplementation(function () {
    return { call: vi.fn<() => unknown>(impl) };
  });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("resolveUploadAuth", () => {
  it("resolves identity from the server for an explicit headless token", async () => {
    (resolveHeadlessToken as any).mockResolvedValue({ token: "poppi_pat_x", source: "flag" });
    mockWhoami(async () => ({ user_id: "u1", primary_email: "ci@acme.dev" }));

    const session = await resolveUploadAuth({ ...baseOpts, flagToken: "poppi_pat_x" });

    expect(session).toMatchObject({
      userId: "u1",
      email: "ci@acme.dev",
      token: "poppi_pat_x",
      endpointUrl,
    });
    // Identity came from the server, not a stored session.
    expect(loadAuthSession).not.toHaveBeenCalled();
  });

  it("uses the stored keychain session when the token came from there", async () => {
    (resolveHeadlessToken as any).mockResolvedValue({ token: "stored", source: "session" });
    (loadAuthSession as any).mockResolvedValue({
      email: "me@acme.dev",
      userId: "u2",
      token: "stored",
      endpointUrl,
      loggedInAt: "2026-05-26T00:00:00.000Z",
    });

    const session = await resolveUploadAuth(baseOpts);

    expect(session.userId).toBe("u2");
    expect(CloudClient).not.toHaveBeenCalled();
  });

  it("throws AuthError when no credential is available (never falls back to OTP)", async () => {
    (resolveHeadlessToken as any).mockResolvedValue(null);
    await expect(resolveUploadAuth(baseOpts)).rejects.toBeInstanceOf(AuthError);
  });

  it("propagates an auth failure from an invalid/revoked token", async () => {
    (resolveHeadlessToken as any).mockResolvedValue({ token: "poppi_pat_bad", source: "env" });
    mockWhoami(async () => {
      throw new AuthError("Authentication failed (401).");
    });

    await expect(
      resolveUploadAuth({ ...baseOpts, env: { POPPI_TOKEN: "poppi_pat_bad" } }),
    ).rejects.toBeInstanceOf(AuthError);
  });
});
